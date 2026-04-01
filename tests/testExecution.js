import { loadSkillIndex, matchSkill } from '../lib/skills.js';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

/**
 * Execution logic
 */
async function executeSkill(skill, input) {
  // We assume the skill's logic is in an index.js in the same folder as SKILL.md
  // skill.path is /.../skills/name/SKILL.md, so we go up one level
  const skillDir = resolve(skill.path, '..');
  const scriptPath = resolve(skillDir, 'index.js');

  try {
    // Node v24 requires file:// URLs for dynamic imports on macOS/Linux
    const module = await import(pathToFileURL(scriptPath).href);
    
    if (typeof module.run !== 'function') {
      throw new Error(`Skill "${skill.name}" missing export async function run(input)`);
    }

    return await module.run(input);
  } catch (err) {
    throw new Error(`Failed to execute ${skill.name}: ${err.message}`);
  }
}

async function testFullFlow(userMessage) {
  console.log(`\n💬 User: "${userMessage}"`);
  
  const skillsDir = resolve(process.cwd(), 'skills');
  const index = loadSkillIndex(skillsDir);
  
  const matchedSkill = matchSkill(userMessage, index);

  if (!matchedSkill) {
    console.log("❌ No skill matched.");
    return;
  }

  console.log(`🎯 Matched: ${matchedSkill.name}`);

  try {
    const result = await executeSkill(matchedSkill, userMessage);
    console.log('\n--- SKILL OUTPUT ---');
    console.log(result);
    console.log('--------------------\n');
  } catch (err) {
    console.error(`🔥 ${err.message}`);
    console.log(`💡 Make sure you created: skills/${matchedSkill.name}/index.js`);
  }
}

testFullFlow("Use reasoning-planning to break down: How would you build a chatbot that learns from user corrections?");

