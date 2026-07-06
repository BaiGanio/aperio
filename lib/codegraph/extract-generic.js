// lib/codegraph/extract-generic.js
// Tree-sitter extractor for languages whose AST follows the usual
// "declaration node with a `name` field" shape: Python, Go, Rust, Java,
// Kotlin, C, C++, C#, Ruby, PHP, Swift, Dart, Bash.
//
// Modeled on extract-ts.js but config-driven. Each language only needs a
// LANG_SPEC entry naming the relevant AST node types — the walking,
// owner-attribution, and edge wiring is shared.

import TreeSitter from 'web-tree-sitter';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const Parser = TreeSitter.default ?? TreeSitter;

// ── Language specs ──────────────────────────────────────────────────────────
// fnTypes / methodTypes / classTypes: AST node types to capture as symbols.
//   - A node listed in fnTypes is a 'method' if it's inside one of classTypes,
//     otherwise a 'function'.
//   - methodTypes are unconditionally 'method' (used when a grammar has a
//     distinct node type for methods, e.g. Ruby's `singleton_method`).
// callTypes: AST node types treated as call sites. fnField names the field
//   that holds the callee subtree.
// importTypes: AST node types treated as imports; the whole node text (first
//   line) becomes the unresolved dst.
// sep: separator used in qualified names between class and method.

const LANG_SPEC = {
  py: {
    grammar: 'tree-sitter-python.wasm',
    fnTypes:     ['function_definition'],
    methodTypes: [],
    classTypes:  ['class_definition'],
    callTypes:   [{ type: 'call', fnField: 'function' }],
    importTypes: ['import_statement', 'import_from_statement'],
    sep: '.',
  },
  go: {
    grammar: 'tree-sitter-go.wasm',
    fnTypes:     ['function_declaration'],
    methodTypes: ['method_declaration'],
    classTypes:  ['type_declaration'],
    callTypes:   [{ type: 'call_expression', fnField: 'function' }],
    importTypes: ['import_declaration'],
    sep: '.',
  },
  rs: {
    grammar: 'tree-sitter-rust.wasm',
    fnTypes:     ['function_item'],
    methodTypes: [],
    classTypes:  ['struct_item', 'enum_item', 'trait_item', 'impl_item', 'mod_item'],
    callTypes:   [{ type: 'call_expression', fnField: 'function' }],
    importTypes: ['use_declaration'],
    sep: '::',
  },
  java: {
    grammar: 'tree-sitter-java.wasm',
    fnTypes:     [],
    methodTypes: ['method_declaration', 'constructor_declaration'],
    classTypes:  ['class_declaration', 'interface_declaration', 'enum_declaration'],
    callTypes:   [{ type: 'method_invocation', fnField: 'name' }],
    importTypes: ['import_declaration'],
    sep: '.',
  },
  kt: {
    grammar: 'tree-sitter-kotlin.wasm',
    fnTypes:     ['function_declaration'],
    methodTypes: [],
    classTypes:  ['class_declaration', 'object_declaration'],
    callTypes:   [{ type: 'call_expression', fnField: 'function' }],
    importTypes: ['import_header'],
    sep: '.',
  },
  c: {
    grammar: 'tree-sitter-c.wasm',
    fnTypes:     ['function_definition'],
    methodTypes: [],
    classTypes:  ['struct_specifier', 'union_specifier'],
    callTypes:   [{ type: 'call_expression', fnField: 'function' }],
    importTypes: ['preproc_include'],
    sep: '.',
  },
  cpp: {
    grammar: 'tree-sitter-cpp.wasm',
    fnTypes:     ['function_definition'],
    methodTypes: [],
    classTypes:  ['class_specifier', 'struct_specifier', 'union_specifier'],
    callTypes:   [{ type: 'call_expression', fnField: 'function' }],
    importTypes: ['preproc_include'],
    sep: '::',
  },
  cs: {
    grammar: 'tree-sitter-c_sharp.wasm',
    fnTypes:     [],
    methodTypes: ['method_declaration', 'constructor_declaration'],
    classTypes:  ['class_declaration', 'interface_declaration', 'struct_declaration', 'record_declaration'],
    callTypes:   [{ type: 'invocation_expression', fnField: 'function' }],
    importTypes: ['using_directive'],
    sep: '.',
  },
  rb: {
    grammar: 'tree-sitter-ruby.wasm',
    fnTypes:     ['method'],
    methodTypes: ['singleton_method'],
    classTypes:  ['class', 'module'],
    callTypes:   [{ type: 'call', fnField: 'method' }],
    importTypes: [],  // Ruby uses `require` calls; pulled in via call edges.
    sep: '#',
  },
  php: {
    grammar: 'tree-sitter-php.wasm',
    fnTypes:     ['function_definition'],
    methodTypes: ['method_declaration'],
    classTypes:  ['class_declaration', 'interface_declaration', 'trait_declaration'],
    callTypes:   [
      { type: 'function_call_expression', fnField: 'function' },
      { type: 'member_call_expression',   fnField: 'name' },
    ],
    importTypes: ['namespace_use_declaration'],
    sep: '::',
  },
  swift: {
    grammar: 'tree-sitter-swift.wasm',
    fnTypes:     ['function_declaration'],
    methodTypes: [],
    classTypes:  ['class_declaration', 'protocol_declaration'],
    callTypes:   [{ type: 'call_expression', fnField: 'function' }],
    importTypes: ['import_declaration'],
    sep: '.',
  },
  // Dart's tree-sitter-wasms grammar is built against ABI 15 while
  // web-tree-sitter currently supports up to ABI 14, so it's left out
  // until the runtime catches up.
  sh: {
    grammar: 'tree-sitter-bash.wasm',
    fnTypes:     ['function_definition'],
    methodTypes: [],
    classTypes:  [],
    callTypes:   [],  // shell commands aren't useful call edges
    importTypes: [],  // `source`/`.` are commands, not import nodes
    sep: '.',
  },
};

// Alias entries so common alternate extensions reuse the same spec.
const EXT_ALIAS = {
  pyi: 'py',
  cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  h: 'c',
  kts: 'kt',
  rake: 'rb', gemspec: 'rb',
  bash: 'sh', zsh: 'sh',
  phtml: 'php',
};

export const SUPPORTED_EXTS = new Set([
  ...Object.keys(LANG_SPEC),
  ...Object.keys(EXT_ALIAS),
]);

function specFor(ext) {
  return LANG_SPEC[EXT_ALIAS[ext] ?? ext] ?? null;
}

// ── Parser cache ────────────────────────────────────────────────────────────

let _parserReady = null;
const _langs = new Map();  // ext → Language

async function getParser(ext) {
  if (!_parserReady) _parserReady = Parser.init();
  await _parserReady;

  const spec = specFor(ext);
  if (!spec) throw new Error(`No tree-sitter spec for .${ext}`);

  if (!_langs.has(spec.grammar)) {
    const wasmPath = path.join(
      path.dirname(require.resolve('tree-sitter-wasms/package.json')),
      'out',
      spec.grammar,
    );
    _langs.set(spec.grammar, await Parser.Language.load(wasmPath));
  }
  const parser = new Parser();
  parser.setLanguage(_langs.get(spec.grammar));
  return parser;
}

// ── Shared helpers (mirrors extract-ts.js) ──────────────────────────────────

function leadingDoc(source, node) {
  const before = source.slice(0, node.startIndex);
  const block = before.match(/\/\*\*([\s\S]*?)\*\/\s*$/);
  if (block) return block[1].replace(/^\s*\*\s?/gm, '').trim();
  const slash = before.match(/((?:\s*\/\/\/?[^\n]*\n)+)\s*$/);
  if (slash) return slash[1].replace(/^\s*\/\/\/?\s?/gm, '').trim();
  const hash = before.match(/((?:\s*#[^\n]*\n)+)\s*$/);
  if (hash) return hash[1].replace(/^\s*#\s?/gm, '').trim();
  return null;
}

function firstLine(node) {
  const sig = node.text.split('\n', 1)[0].trim();
  return sig.length > 200 ? sig.slice(0, 197) + '...' : sig;
}

function nameOf(node) {
  // Prefer the `name` field where the grammar exposes it.
  const named = node.childForFieldName('name');
  if (named) return named.text;
  // C-family wraps the identifier inside a (possibly nested) declarator.
  const decl = node.childForFieldName('declarator');
  if (decl) {
    const inner = nameOf(decl);
    if (inner) return inner;
  }
  // Grammars like Kotlin expose `simple_identifier` / `type_identifier`
  // as the first identifier-typed named child.
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c.type === 'identifier' || c.type.endsWith('_identifier')) return c.text;
  }
  return null;
}

function* walk(node) {
  yield node;
  for (let i = 0; i < node.namedChildCount; i++) {
    yield* walk(node.namedChild(i));
  }
}

function findOwner(symbols, index) {
  let best = null, bestSize = Infinity;
  for (const s of symbols) {
    if (s.startIdx <= index && index <= s.endIdx) {
      const size = s.endIdx - s.startIdx;
      if (size < bestSize) { best = s; bestSize = size; }
    }
  }
  return best?.localId ?? null;
}

function enclosingClass(node, classTypes) {
  let p = node.parent;
  while (p) {
    if (classTypes.includes(p.type)) return p;
    p = p.parent;
  }
  return null;
}

// Best-effort extraction of a callee's leaf name (`foo`, or last segment of
// `a.b.foo` / `a::b::foo`). Returns null when not a plain identifier.
function calleeName(fn) {
  if (!fn) return null;
  // Common member-access shapes across grammars.
  const member = ['member_expression', 'field_expression', 'scoped_identifier', 'navigation_expression'];
  if (member.includes(fn.type)) {
    const last = fn.childForFieldName('property')
              ?? fn.childForFieldName('field')
              ?? fn.childForFieldName('name')
              ?? fn.namedChild(fn.namedChildCount - 1);
    if (last) return last.text;
  }
  const txt = fn.text;
  if (/^[A-Za-z_$][\w$]*$/.test(txt)) return txt;
  return null;
}

// ── Main extract ────────────────────────────────────────────────────────────

export async function extract(source, filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const spec = specFor(ext);
  if (!spec) throw new Error(`No tree-sitter spec for .${ext}`);

  let parser, tree;
  try {
    parser = await getParser(ext);
    tree   = parser.parse(source);
    if (!tree?.rootNode) {
      const err = new Error(`tree-sitter returned no tree for ${filePath}`);
      err.code = 'EXTRACT_EMPTY_TREE';
      throw err;
    }
  } catch (err) {
    err.message = `extract failed for ${filePath}: ${err.message}`;
    throw err;
  }

  const symbols = [];
  const edges   = [];
  let nextId = 0;
  const newId = () => `s${nextId++}`;

  const pushSymbol = (node, kind, name, qualified) => {
    const localId = newId();
    symbols.push({
      localId, kind, name, qualified,
      start_line: node.startPosition.row + 1,
      end_line:   node.endPosition.row + 1,
      signature:  firstLine(node),
      doc:        leadingDoc(source, node),
      startIdx:   node.startIndex,
      endIdx:     node.endIndex,
    });
    return localId;
  };

  const callTypeMap = new Map(spec.callTypes.map(c => [c.type, c.fnField]));
  const importSet   = new Set(spec.importTypes);

  // Pass 1: symbols.
  const seenClass = new Set();
  for (const node of walk(tree.rootNode)) {
    if (spec.classTypes.includes(node.type)) {
      const name = nameOf(node);
      if (!name) continue;
      const qualified = `${filePath}::${name}`;
      // Rust impl_item shares a name with the struct/enum/trait it extends —
      // keep the impl as an owner for method climbing without re-emitting.
      if (seenClass.has(qualified)) continue;
      seenClass.add(qualified);
      pushSymbol(node, 'class', name, qualified);
      continue;
    }
    const isMethod = spec.methodTypes.includes(node.type);
    const isFn     = spec.fnTypes.includes(node.type);
    if (!isMethod && !isFn) continue;

    const name = nameOf(node);
    if (!name) continue;

    const parentClass = enclosingClass(node, spec.classTypes);
    if (isMethod || parentClass) {
      const className = parentClass ? nameOf(parentClass) : null;
      const qualified = className
        ? `${filePath}::${className}${spec.sep}${name}`
        : `${filePath}::${name}`;
      pushSymbol(node, 'method', name, qualified);
    } else {
      pushSymbol(node, 'function', name, `${filePath}::${name}`);
    }
  }

  // Pass 2: edges.
  for (const node of walk(tree.rootNode)) {
    if (importSet.has(node.type)) {
      const mod = firstLine(node);
      edges.push({
        srcLocalId: '__file__',
        dst_unresolved: mod,
        kind: 'imports',
        src_line: node.startPosition.row + 1,
      });
      continue;
    }
    const fnField = callTypeMap.get(node.type);
    if (fnField === undefined) continue;
    const callee = calleeName(node.childForFieldName(fnField));
    if (!callee) continue;
    const owner = findOwner(symbols, node.startIndex);
    if (!owner) continue;
    edges.push({
      srcLocalId: owner,
      dst_unresolved: callee,
      kind: 'calls',
      src_line: node.startPosition.row + 1,
    });
  }

  return { symbols, edges };
}
