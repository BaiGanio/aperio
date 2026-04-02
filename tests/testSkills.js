import { loadSkillIndex, matchSkill } from '../lib/skills.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

/**
 * Test: Load all skills
 */
function testLoadSkills() {
  console.log('\n📚 Testing: Load All Skills\n');
  console.log('─'.repeat(60));

  const skillsDir = resolve(rootDir, 'skills');
  const index = loadSkillIndex(skillsDir);

  if (index.length === 0) {
    console.log('⚠️  No skills found in /skills directory');
    console.log(`   Expected path: ${skillsDir}`);
    return false;
  }

  console.log(`✅ Found ${index.length} skill(s):\n`);

  index.forEach((skill) => {
    console.log(`📌 ${skill.name}`);
    console.log(`   Description: ${skill.description || 'N/A'}`);
    console.log(`   Path: ${skill.path}`);
    console.log(`   Content length: ${skill.content.length} characters`);
    console.log();
  });

  console.log('─'.repeat(60));
  return true;
}

/**
 * Test: Match a skill based on user message
 */
function testMatchSkill(userMessage, expectedSkill = null) {
  console.log(`\n🔍 Testing: Match Skill for "${userMessage}"\n`);
  console.log('─'.repeat(60));

  const skillsDir = resolve(rootDir, 'skills');
  const index = loadSkillIndex(skillsDir);

  const matched = matchSkill(userMessage, index);

  if (matched) {
    console.log(`✅ Matched skill: ${matched.name}`);
    console.log(`   Description: ${matched.description}`);
    
    if (expectedSkill && matched.name !== expectedSkill) {
      console.log(`⚠️  Expected: ${expectedSkill}, got: ${matched.name}`);
      console.log('─'.repeat(60));
      return false;
    }
  } else {
    console.log(`❌ No skill matched for: "${userMessage}"`);
    console.log('─'.repeat(60));
    return false;
  }

  console.log('─'.repeat(60));
  return true;
}

/**
 * Test: Verify skill structure and content
 */
function testSkillStructure() {
  console.log('\n✔️  Testing: Skill Structure Validation\n');
  console.log('─'.repeat(60));

  const skillsDir = resolve(rootDir, 'skills');
  const index = loadSkillIndex(skillsDir);

  if (index.length === 0) {
    console.log('⚠️  No skills to validate');
    return false;
  }

  let allValid = true;

  index.forEach((skill) => {
    const hasName = !!skill.name;
    const hasDescription = !!skill.description;
    const hasContent = skill.content && skill.content.length > 0;

    if (hasName && hasDescription && hasContent) {
      console.log(`✅ ${skill.name} - Valid structure`);
    } else {
      console.log(`❌ ${skill.name} - Missing: ${[
        !hasName && 'name',
        !hasDescription && 'description',
        !hasContent && 'content',
      ]
        .filter(Boolean)
        .join(', ')}`);
      allValid = false;
    }
  });

  console.log('─'.repeat(60));
  return allValid;
}

/**
 * Test: Search for specific sections in skill content
 */
function testSkillContent(skillName, searchTerm) {
  console.log(`\n🔎 Testing: Search "${searchTerm}" in "${skillName}"\n`);
  console.log('─'.repeat(60));

  const skillsDir = resolve(rootDir, 'skills');
  const index = loadSkillIndex(skillsDir);
  const skill = index.find((s) => s.name === skillName);

  if (!skill) {
    console.log(`❌ Skill not found: ${skillName}`);
    console.log('─'.repeat(60));
    return false;
  }

  const found = skill.content.toLowerCase().includes(searchTerm.toLowerCase());

  if (found) {
    console.log(`✅ Found "${searchTerm}" in ${skillName}`);

    // Show context (50 chars before and after)
    const index_pos = skill.content.toLowerCase().indexOf(searchTerm.toLowerCase());
    const start = Math.max(0, index_pos - 50);
    const end = Math.min(skill.content.length, index_pos + searchTerm.length + 50);
    const context = skill.content.substring(start, end);

    console.log(`\nContext:\n...${context}...\n`);
  } else {
    console.log(`❌ "${searchTerm}" not found in ${skillName}`);
  }

  console.log('─'.repeat(60));
  return found;
}

/**
 * Run all tests
 */
function runAllTests() {
  console.log('\n');
  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║' + ' '.repeat(12) + '🤖 SKILL LOADER TEST SUITE (Aperio)' + ' '.repeat(10) + '║');
  console.log('╚' + '═'.repeat(58) + '╝');

  const results = [];

  // Test 1: Load all skills
  results.push({
    name: 'Load All Skills',
    passed: testLoadSkills(),
  });

  // Test 2: Load individual skills
  results.push({
    name: 'Load reasoning-planning',
    passed: testMatchSkill('reasoning and planning', 'reasoning-planning'),
  });

  results.push({
    name: 'Load tool-integration',
    passed: testMatchSkill('tool integration', 'tool-integration'),
  });

  results.push({
    name: 'Load memory-learning',
    passed: testMatchSkill('memory learning', 'memory-learning'),
  });

  // Test 3: Validate structure
  results.push({
    name: 'Skill Structure Validation',
    passed: testSkillStructure(),
  });

  // Test 4: Search content
  results.push({
    name: 'Search: "When to Use"',
    passed: testSkillContent('reasoning-planning', 'When to Use'),
  });

  // Test 5: coding-standards skill — load & match
  results.push({
    name: 'Load coding-standards',
    passed: testLoadSingleSkill('coding-standards'),
  });

  results.push({
    name: 'Match coding-standards: "naming conventions"',
    passed: testMatchSkill('naming conventions', 'coding-standards'),
  });

  results.push({
    name: 'Match coding-standards: "code style review"',
    passed: testMatchSkill('code style review', 'coding-standards'),
  });

  results.push({
    name: 'Match coding-standards: "camelCase"',
    passed: testMatchSkill('should I use camelCase here?', 'coding-standards'),
  });

  // Test 6: coding-standards skill — content checks
  results.push({
    name: 'coding-standards has "When to Use"',
    passed: testSkillContent('coding-standards', 'When to Use'),
  });

  results.push({
    name: 'coding-standards has camelCase rule',
    passed: testSkillContent('coding-standards', 'camelCase'),
  });

  results.push({
    name: 'coding-standards has PascalCase rule',
    passed: testSkillContent('coding-standards', 'PascalCase'),
  });

  results.push({
    name: 'coding-standards has UPPER_SNAKE_CASE rule',
    passed: testSkillContent('coding-standards', 'UPPER_SNAKE_CASE'),
  });

  results.push({
    name: 'coding-standards has error handling rule',
    passed: testSkillContent('coding-standards', 'error handling'),
  });

  results.push({
    name: 'coding-standards has good/bad examples',
    passed: testSkillContent('coding-standards', '✅ Good'),
  });

  // Test 7: system_prompt validation
  results.push({
    name: 'system_prompt: loads and has content',
    passed: testSystemPrompt('has-content'),
  });

  results.push({
    name: 'system_prompt: references coding-standards skill',
    passed: testSystemPrompt('references-skill'),
  });

  results.push({
    name: 'system_prompt: defines recall tool',
    passed: testSystemPrompt('has-recall'),
  });

  results.push({
    name: 'system_prompt: defines memory lifecycle',
    passed: testSystemPrompt('has-lifecycle'),
  });

  results.push({
    name: 'system_prompt: no inline coding rules (clean separation)',
    passed: testSystemPrompt('no-inline-coding-rules'),
  });

  // Summary
  console.log('\n');
  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║' + ' '.repeat(20) + '📊 TEST SUMMARY' + ' '.repeat(23) + '║');
  console.log('╠' + '═'.repeat(58) + '╣');

  results.forEach((result) => {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    const padding = ' '.repeat(Math.max(0, 50 - result.name.length));
    console.log(`║ ${result.name}${padding}${status} ║`);
  });

  const passCount = results.filter((r) => r.passed).length;
  console.log('╠' + '═'.repeat(58) + '╣');
  console.log(`║ Total: ${passCount}/${results.length} passed ${' '.repeat(40 - passCount.toString().length - results.length.toString().length)}║`);
  console.log('╚' + '═'.repeat(58) + '╝\n');

  return passCount === results.length;
}

/**
 * Test: Validate system_prompt.md integrity
 * Checks structural guarantees — not content accuracy.
 * assertion types:
 *   'has-content'            — file exists and is non-empty
 *   'references-skill'       — delegates coding rules to the skill file
 *   'has-recall'             — recall tool is defined
 *   'has-lifecycle'          — conversation lifecycle sections are present
 *   'no-inline-coding-rules' — naming convention details are NOT inlined
 */
function testSystemPrompt(assertion) {
  const promptPath = resolve(rootDir, 'prompts', 'system_prompt.md');
  console.log(`\n📋 Testing system_prompt [${assertion}]\n`);
  console.log('─'.repeat(60));

  if (!existsSync(promptPath)) {
    console.log(`❌ system_prompt.md not found at: ${promptPath}`);
    console.log('─'.repeat(60));
    return false;
  }

  const content = readFileSync(promptPath, 'utf-8');
  let passed = false;
  let reason = '';

  switch (assertion) {
    case 'has-content':
      passed = content.trim().length > 100;
      reason = passed ? 'File loaded with content' : 'File missing or too short';
      break;

    case 'references-skill':
      passed = content.includes('coding-standards');
      reason = passed
        ? 'References coding-standards skill'
        : 'Missing reference to coding-standards/SKILL.md';
      break;

    case 'has-recall':
      passed = content.includes('recall');
      reason = passed ? 'recall tool defined' : 'recall tool missing';
      break;

    case 'has-lifecycle':
      passed =
        content.includes('START of every conversation') &&
        content.includes('END of every conversation');
      reason = passed ? 'Lifecycle sections present' : 'Missing START or END lifecycle section';
      break;

    case 'no-inline-coding-rules': {
      const hasInlineNaming =
        content.includes('camelCase') ||
        content.includes('PascalCase') ||
        content.includes('UPPER_SNAKE_CASE');
      passed = !hasInlineNaming;
      reason = passed
        ? 'No inline naming conventions — correctly delegated to skill'
        : 'Inline naming conventions found — should be in coding-standards skill instead';
      break;
    }

    default:
      reason = `Unknown assertion: ${assertion}`;
  }

  console.log(passed ? `✅ ${reason}` : `❌ ${reason}`);
  console.log('─'.repeat(60));
  return passed;
}

/**
 * Test: Load a single skill by name
 */
function testLoadSingleSkill(skillName) {
  console.log(`\n🔍 Testing: Load Single Skill "${skillName}"\n`);
  const skillsDir = resolve(rootDir, 'skills');
  const index = loadSkillIndex(skillsDir);
  const skill = index.find(s => s.name === skillName);

  if (skill) {
    console.log(`✅ Found: ${skill.name}`);
    return true;
  } else {
    console.log(`❌ Skill not found: ${skillName}`);
    return false;
  }
}

// Run tests if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const allPassed = runAllTests();
  process.exit(allPassed ? 0 : 1);
}

export { testLoadSkills, testMatchSkill, testSkillStructure, testSkillContent, runAllTests, testLoadSingleSkill, testSystemPrompt };