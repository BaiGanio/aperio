// lib/codegraph/extract-ts.js
// Tree-sitter based extractor for JS / JSX / TS / TSX. Replaces the regex
// extractor — handles nested classes, TS generics, decorators, template
// strings, object-literal methods, and async arrows correctly.
//
// Grammars come from `tree-sitter-wasms` (prebuilt, no native toolchain).

import TreeSitter from 'web-tree-sitter';
import { createRequire } from 'module';
import path from 'path';
import { docWindow, leadingBlockDoc, leadingLineDoc } from './doc-comment.js';
import { createOwnerIndex } from './owner-index.js';

const require = createRequire(import.meta.url);
const Parser = TreeSitter.default ?? TreeSitter;

let _parserReady = null;
const _langs   = new Map();  // ext → Language
// web-tree-sitter allocates parsers and trees in the WASM heap, which V8's
// garbage collector never touches. A fresh `new Parser()` per file leaked one
// parser per file until the heap could not grow and aborted the process in the
// middle of a large index pass. One parser per grammar, reused forever.
const _parsers = new Map();  // ext → Parser (WASM-heap resident)

async function getParser(ext) {
  if (!_parserReady) _parserReady = Parser.init();
  await _parserReady;

  if (!_langs.has(ext)) {
    const grammarFile = {
      js:  'tree-sitter-javascript.wasm',
      mjs: 'tree-sitter-javascript.wasm',
      cjs: 'tree-sitter-javascript.wasm',
      jsx: 'tree-sitter-javascript.wasm',
      ts:  'tree-sitter-typescript.wasm',
      tsx: 'tree-sitter-tsx.wasm',
    }[ext];
    if (!grammarFile) throw new Error(`No tree-sitter grammar for .${ext}`);
    const wasmPath = path.join(
      path.dirname(require.resolve('tree-sitter-wasms/package.json')),
      'out',
      grammarFile,
    );
    _langs.set(ext, await Parser.Language.load(wasmPath));
  }

  // Safe to share: parse() and the whole tree traversal in extractFromTree()
  // below are synchronous, so two concurrent extract() calls can never
  // interleave on the same parser.
  if (!_parsers.has(ext)) {
    const parser = new Parser();
    parser.setLanguage(_langs.get(ext));
    _parsers.set(ext, parser);
  }
  return _parsers.get(ext);
}

const SYMBOL_TYPES = new Set([
  'function_declaration', 'generator_function_declaration',
  'class_declaration', 'method_definition',
  'lexical_declaration',  // const foo = () => ...
  'function_expression', 'arrow_function',  // when assigned to variable
]);

// Strip a leading JSDoc / line-comment block that sits immediately above `node`.
// See lib/codegraph/doc-comment.js for why this is a bounded window and not a
// regex over the whole file prefix.
function leadingDoc(source, node) {
  const before = docWindow(source, node.startIndex);
  return leadingBlockDoc(before)
      ?? leadingLineDoc(before, (l) => l.startsWith('//'), /^\/\/\s?/);
}

function firstLine(node) {
  const sig = node.text.split('\n', 1)[0].trim();
  return sig.length > 200 ? sig.slice(0, 197) + '...' : sig;
}

function nameOf(node) {
  // Most declarations expose `name` as a field.
  const n = node.childForFieldName('name');
  if (n) return n.text;
  // arrow_function / function_expression have no name themselves —
  // resolved at the assignment site (lexical_declaration handler).
  return null;
}

/**
 * Walk every named descendant of root and yield it.
 * Cheaper than TreeCursor for this use case and easier to reason about.
 */
function* walk(node) {
  yield node;
  for (let i = 0; i < node.namedChildCount; i++) {
    yield* walk(node.namedChild(i));
  }
}

export async function extract(source, filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  let parser, tree;
  try {
    parser = await getParser(ext);
    tree   = parser.parse(source);
    // Tree-sitter may return null on extreme inputs (oversized files, etc.)
    if (!tree?.rootNode) {
      const err = new Error(`tree-sitter returned no tree for ${filePath}`);
      err.code = 'EXTRACT_EMPTY_TREE';
      throw err;
    }
  } catch (err) {
    err.message = `extract failed for ${filePath}: ${err.message}`;
    throw err;
  }
  // The tree is WASM-heap resident too — free it the moment traversal is done.
  try { return extractFromTree(tree, source, filePath); }
  finally { tree.delete(); }
}

// Synchronous, and it must stay that way: see the parser-sharing note above.
function extractFromTree(tree, source, filePath) {
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

  // First pass: declare every symbol so call-site attribution works in pass 2.
  for (const node of walk(tree.rootNode)) {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = nameOf(node);
        if (name) pushSymbol(node, 'function', name, `${filePath}::${name}`);
        break;
      }
      case 'class_declaration': {
        const name = nameOf(node);
        if (!name) break;
        const localId = pushSymbol(node, 'class', name, `${filePath}::${name}`);
        // extends edge
        const heritage = node.childForFieldName('heritage') ||
                         node.descendantsOfType?.('class_heritage')?.[0];
        if (heritage) {
          const parentName = heritage.namedChild(0)?.text;
          if (parentName) {
            edges.push({
              srcLocalId: localId,
              dst_unresolved: parentName.replace(/^extends\s+/, '').trim(),
              kind: 'extends',
              src_line: node.startPosition.row + 1,
            });
          }
        }
        break;
      }
      case 'method_definition': {
        const name = nameOf(node);
        if (!name) break;
        // climb to the enclosing class for the qualified name
        let p = node.parent;
        while (p && p.type !== 'class_declaration' && p.type !== 'class') p = p.parent;
        const className = p ? nameOf(p) : null;
        const qualified = className
          ? `${filePath}::${className}.${name}`
          : `${filePath}::${name}`;
        pushSymbol(node, 'method', name, qualified);
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        // const/let/var — only capture when the initializer is a function.
        for (let i = 0; i < node.namedChildCount; i++) {
          const decl = node.namedChild(i);
          if (decl.type !== 'variable_declarator') continue;
          const name = decl.childForFieldName('name')?.text;
          const init = decl.childForFieldName('value');
          if (!name || !init) continue;
          if (init.type === 'arrow_function' || init.type === 'function_expression') {
            pushSymbol(decl, 'const', name, `${filePath}::${name}`);
          }
        }
        break;
      }
    }
  }

  // Pass 2: edges (imports, calls). Done after symbols so call-site
  // attribution uses the fully populated symbol table — which is also why the
  // owner index can be built once, here, rather than per call site.
  const ownerAt = createOwnerIndex(symbols);
  for (const node of walk(tree.rootNode)) {
    if (node.type === 'import_statement') {
      const src = node.childForFieldName('source');
      if (src) {
        const mod = src.text.replace(/^['"`]|['"`]$/g, '');
        edges.push({
          srcLocalId: '__file__',
          dst_unresolved: mod,
          kind: 'imports',
          src_line: node.startPosition.row + 1,
        });
      }
    } else if (node.type === 'call_expression') {
      const fn = node.childForFieldName('function');
      if (!fn) continue;
      // Pull just the callee name — `foo`, or last segment of `a.b.foo`.
      const callee = fn.type === 'member_expression'
        ? fn.childForFieldName('property')?.text
        : fn.text;
      if (!callee || !/^[A-Za-z_$][\w$]*$/.test(callee)) continue;
      const owner = ownerAt(node.startIndex);
      if (!owner) continue;
      edges.push({
        srcLocalId: owner,
        dst_unresolved: callee,
        kind: 'calls',
        src_line: node.startPosition.row + 1,
      });
    }
  }

  return { symbols, edges };
}
