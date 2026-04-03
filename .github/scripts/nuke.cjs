const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

module.exports = async ({ github, context, targetUser, prData = null, issueNumber = null, silent = false, isOrg = false }) => {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const targetNumber = prData ? prData.number : issueNumber;
  const isPrOwner = prData && targetUser.toLowerCase() === prData.user.login.toLowerCase();

  // ── 🛡️ REPO OWNER PROTECTION ──────────────────────────────────────────
  if (targetUser.toLowerCase() === owner.toLowerCase()) {
    console.log(`[SAFEGUARD] @${targetUser} is the Repo Owner. Nuke cancelled.`);
    return;
  }

  const targetType = isOrg ? 'organization' : 'user';
  console.log(`[NUKE] Banning @${targetUser} (${targetType}). PR Owner? ${isPrOwner}`);

  // 1. Update blocklist.json
  const blocklistPath = path.join(__dirname, '..', 'data', 'blocklist.json');
  let blocklist = { blocked: [] };
  try {
    blocklist = JSON.parse(fs.readFileSync(blocklistPath, 'utf8'));
  } catch (e) {}

  const isAlreadyBlocked = blocklist.blocked.some(entry => 
    (typeof entry === 'string' ? entry : entry.name).toLowerCase() === targetUser.toLowerCase()
  );

  if (!isAlreadyBlocked) {
    blocklist.blocked.push({
      name: targetUser,
      isOrg: isOrg,
      bannedAt: new Date().toISOString(),
      reason: 'spam or policy violation'
    });
    fs.writeFileSync(blocklistPath, JSON.stringify(blocklist, null, 2));

    execSync('git config user.name "github-actions[bot]"');
    execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
    execSync(`git add ${blocklistPath}`);
    execSync(`git commit -m "chore: ban @${targetUser} (${targetType}) for spam [skip ci]"`);
    
    const pat = process.env.INPUT_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    execSync(`git push https://x-access-token:${pat}@github.com/${owner}/${repo}.git HEAD:master`);
  }

  // 2. Delete comments from this user/org
  if (targetNumber) {
    const comments = await github.paginate(github.rest.issues.listComments, { 
      owner, repo, issue_number: targetNumber, per_page: 100 
    });
    for (const c of comments) {
      if (c.user.login.toLowerCase() === targetUser.toLowerCase()) {
        await github.rest.issues.deleteComment({ owner, repo, comment_id: c.id }).catch(() => {});
      }
    }
  }

  // 3. CLEANUP ASSIGNMENTS & PRs
  if (prData && targetNumber) {
    if (isPrOwner) {
      await github.rest.pulls.update({
        owner, repo, pull_number: targetNumber,
        state: 'closed',
        title: `[REMOVED] Policy Violation`,
        body: `Author (@${targetUser}) banned for repeated violations.`
      });
      if (!prData.head.repo?.fork) {
        await github.rest.git.deleteRef({ owner, repo, ref: `heads/${prData.head.ref}` }).catch(() => {});
      }
    } else if (!silent) {
      await github.rest.issues.createComment({
        owner, repo, issue_number: targetNumber,
        body: `> [!NOTE]\n> Removed spam from @${targetUser}. ${targetType.charAt(0).toUpperCase() + targetType.slice(1)} has been banned.`
      });
    }
  }

  // 4. Unassign and remove labels
  if (targetNumber) {
    await github.rest.issues.update({
      owner, repo, issue_number: targetNumber, assignees: []
    }).catch(() => {});
    
    await github.rest.issues.removeLabel({
      owner, repo, issue_number: targetNumber, name: 'status: claimed'
    }).catch(() => {});
  }

  // 5. ORG-SPECIFIC: Block the org from the repo (if applicable)
  if (isOrg) {
    try {
      // Note: This requires repo admin permissions
      // GitHub doesn't have a direct "block org" API, but we log it
      console.log(`[INFO] @${targetUser} is an organization. Manual review may be needed for repo-level blocking.`);
    } catch (e) {
      console.error(`[WARN] Could not apply org-specific blocks:`, e.message);
    }
  }

  console.log(`[SUCCESS] @${targetUser} (${targetType}) has been nuked.`);
};
