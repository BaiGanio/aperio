import { loadSkillIndex, matchSkill } from '../lib/skills.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

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

export { testLoadSkills, testMatchSkill, testSkillStructure, testSkillContent, runAllTests, testLoadSingleSkill};
