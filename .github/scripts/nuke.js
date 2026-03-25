const fs = require('fs');
const { execSync } = require('child_process');

module.exports = async ({ github, context, targetUser,  prData = null, issueNumber = null, silent = false }) => {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const targetNumber = prData ? prData.number : issueNumber;
  const isPrOwner = targetUser.toLowerCase() === prData.user.login.toLowerCase();

  // ── 🛡️ REPO OWNER PROTECTION ──────────────────────────────────────────
  if (targetUser.toLowerCase() === owner.toLowerCase()) {
    console.log(`[SAFEGUARD] @${targetUser} is the Repo Owner. Nuke cancelled.`);
    return; // Exit immediately
  }

  console.log(`[NUKE] Banning @${targetUser}. PR Owner? ${isPrOwner}`);

  // 1. Update blocklist.json
  const blocklistPath = '.github/blocklist.json';
  let blocklist = { blocked: [] };
  try {
    blocklist = JSON.parse(fs.readFileSync(blocklistPath, 'utf8'));
  } catch (e) {}

  if (!blocklist.blocked.map(u => u.toLowerCase()).includes(targetUser.toLowerCase())) {
    blocklist.blocked.push(targetUser);
    fs.writeFileSync(blocklistPath, JSON.stringify(blocklist, null, 2));

    execSync('git config user.name "github-actions[bot]"');
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
    execSync(`git add ${blocklistPath}`);
    execSync(`git commit -m "chore: ban @${targetUser} for spam [skip ci]"`);
    
    // Corrected Push URL
    const pat = process.env.INPUT_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    execSync(`git push https://x-access-token:${pat}@://github.com{owner}/${repo}.git HEAD:master`);
  }

  // 2. Delete comments
  const comments = await github.paginate(github.rest.issues.listComments, { 
    owner, repo, issue_number: targetNumber, per_page: 100 
  });
  for (const c of comments) {
    if (c.user.login.toLowerCase() === targetUser.toLowerCase()) {
      await github.rest.issues.deleteComment({ owner, repo, comment_id: c.id }).catch(() => {});
    }
  }

  // 3. CLEANUP ASSIGNMENTS & PRs
  if (prData) {
     if (isPrOwner) {
      await github.rest.pulls.update({
        owner, repo, pull_number: targetNumber,
        state: 'closed',
        title: `[REMOVED] Policy Violation`,
        body: "Author banned for repeated violations."
      });
      if (!prData.head.repo?.fork) {
        await github.rest.git.deleteRef({ owner, repo, ref: `heads/${prData.head.ref}` }).catch(() => {});
      }
    } else if (!silent) {
      // ONLY post this if NOT in silent mode
      await github.rest.issues.createComment({
        owner, repo, issue_number: targetNumber,
        body: `> [!NOTE]\n> Removed spam from @${targetUser}. User has been banned.`
      });
    }
  }
  // Issue specific cleanup: Unassign
  await github.rest.issues.update({
    owner, repo, issue_number: targetNumber, assignees: []
  }).catch(() => {});
  
  await github.rest.issues.removeLabel({
    owner, repo, issue_number: targetNumber, name: 'status: claimed'
  }).catch(() => {});
};
