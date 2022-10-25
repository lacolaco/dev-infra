import * as core from '@actions/core';
import { PullRequestValidationConfig } from '../../../../ng-dev/pr/common/validation/validation-config.js';
import { assertValidPullRequestConfig, PullRequestConfig } from '../../../../ng-dev/pr/config/index.js';
import { loadAndValidatePullRequest } from '../../../../ng-dev/pr/merge/pull-request.js';
import { AutosquashMergeStrategy } from '../../../../ng-dev/pr/merge/strategies/autosquash-merge.js';
import { assertValidGithubConfig, getConfig, GithubConfig, setConfig } from '../../../../ng-dev/utils/config.js';
import { AuthenticatedGitClient } from '../../../../ng-dev/utils/git/authenticated-git-client.js';
import {ANGULAR_ROBOT, getAuthTokenFor, revokeActiveInstallationToken} from '../../../../github-actions/utils.js';
import { MergeConflictsFatalError } from '../../../../ng-dev/pr/merge/failures.js';
import { chdir, cwd } from 'process';
import { mkdir } from 'fs/promises';
import { spawnSync } from 'child_process';

interface CommmitStatus {
  state: 'pending' | 'error' | 'failure' | 'success';
  description: string;
}

async function main(repo: {owner: string, repo: string}, token: string, pr: number) {
  if (isNaN(pr)) {
    core.setFailed('The provided pr value was not a number');
    return;
  }

  chdir('/tmp/');
  spawnSync('git', ['clone', `https://github.com/${owner}/${repo}.git`, 'branch-manager-repo'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  chdir('/tmp/branch-manager-repo');

  

  // Manually define the configuration for the pull request and github to prevent having to
  // checkout the repository before defining the config.
  setConfig(<{pullRequest: PullRequestConfig; github: GithubConfig}>{
    github: {
      mainBranchName: 'main',
      owner: repo.owner,
      name: repo.repo,
    },
    pullRequest: {
      githubApiMerge: false,
    }
  })
  /** The configuration used for the ng-dev tooling. */
  const config = await getConfig([assertValidGithubConfig, assertValidPullRequestConfig]);

  AuthenticatedGitClient.configure(token);
  /** The git client used to perform actions. */
  const git = await AuthenticatedGitClient.get();



  /** The pull request after being retrieved and validated. */
  const pullRequest = await loadAndValidatePullRequest({git, config}, pr, new PullRequestValidationConfig());
  /** Whether any fatal validation failures were discovered. */
  let hasFatalFailures = false;
  /** The status information to be pushed as a status to the pull request. */
  let statusInfo: CommmitStatus = await (async () => {
    // Log validation failures and check for any fatal failures.
    if (pullRequest.validationFailures.length !== 0) {
      for (const failure of pullRequest.validationFailures) {
        hasFatalFailures = !failure.canBeForceIgnored || hasFatalFailures;
        await core.group('Validation failures', async () => {
          core.info(failure.message);
        });
      }
    }

    // With any fatal failure the check is not necessary to do.
    if (hasFatalFailures) {
      return {
        description: 'Waiting to check mergeability due to failing status(es)',
        state: 'pending',
      }
    }

    try {
      git.run(['checkout', 'main']);
        /**
         * A merge strategy used to perform the merge check.
         * Any concrete class implementing MergeStrategy is sufficient as all of our usage is
         * defined in the abstract base class.
         * */
        const strategy = new AutosquashMergeStrategy(git);
        await strategy.prepare(pullRequest);
        await strategy.check(pullRequest);
        return {
          description: `Merges cleanly to ${pullRequest.targetBranches.join(', ')}`,
          state: 'success',
        }
    } catch (e) {
      // As the merge strategy class will express the failures during checks, any thrown error is a
      // failure for our merge check.
      let description: string;
      if (e instanceof MergeConflictsFatalError) {
        description = `Unable to merge into ${e.failedBranches.join(', ')} please update changes or PR target`;
      } else {
        description= 'Cannot cleanly merge to all target branches, please update changes or PR target';
      }
      return {
        description,
        state: 'failure',
      }
    }
  })();

  await git.github.repos.createCommitStatus({
    ...repo,
    ...statusInfo,
    sha: pullRequest.headSha,
    context: 'Branch Manager',
  });
}




/** The token for the angular robot to perform actions. */
const token = await getAuthTokenFor(ANGULAR_ROBOT);
/** The repository name for the pull request. */
const repo = core.getInput('repo', {required: true, trimWhitespace: true});
/** The owner of the repository for the pull request. */
const owner = core.getInput('owner', {required: true, trimWhitespace: true});
/** The pull request number. */
const pr = Number(core.getInput('pr', {required: true, trimWhitespace: true}));

try {
  main({repo, owner}, token, pr).catch((e: Error) => {
    core.error(e);
    core.setFailed(e.message);
  });
} finally {
  await revokeActiveInstallationToken(token);
}
