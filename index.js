const core = require('@actions/core');
const { context, getOctokit } = require('@actions/github');

async function ghRemoveLabels(octokit, label) {
  await octokit.issues.removeLabel({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    name: label,
  });
}

async function ghCreateComment(octokit, body) {
  await octokit.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    body
  });
}

async function removeLabel(octokit, label) {
  try {
    core.info("Removing label to PR");
    await ghRemoveLabels(octokit, label);
  } catch (e) {}
}

async function ghAddLabels(octokit, labels) {
  await octokit.issues.addLabels({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    labels,
  });
}

async function run() {

  const githubToken = core.getInput('github_token', {required: true});
  const label = core.getInput('label', {required: true});
  const leaddevTeamId = core.getInput('leaddev_team_id', {required: true});
  const requiredChecks = core.getInput('required_checks', {required: false});

  const octokit = getOctokit(githubToken);

  core.info(`Triggered action: ${context.payload.action}`);

  try {
    const labelNames = context.payload.pull_request.labels.map((lb) => lb.name);
    if (
      ('unlabeled' === context.payload.action && !labelNames.includes(label)) ||
      ('labeled' === context.payload.action && !labelNames.includes(label))
    ) {
      core.info("Nothing to do.");
      return;
    }

    if (context.payload.pull_request.draft && labelNames.includes(label)) {
      throw new Error(":bulb: release-ready: removing label on draft PR.");
    }

    if (context.payload.pull_request.draft) {
      core.info("Nothing to do.");
      return;
    }

    const regExp = /(RP|WR|API|TS|BB|BP|DS|DP|TRI|BK)-[\d]{1,5}/;
    if (!regExp.exec(context.payload.pull_request.body)) {
      throw new Error(":x: release-ready: body must contains at least one JIRA reference.");
    }

    if (context.payload.pull_request.requested_reviewers.length) {
      const message = context.payload.pull_request.requested_reviewers.length > 1
        ? `${context.payload.pull_request.requested_reviewers.length} reviews are expected.`
        : "one last review is expected.";
      throw new Error(`:bulb: release-ready: ${message}`);
    }

    const reviews_url = `${context.payload.pull_request.url}/reviews?per_page=100`;
    const reviews = await octokit.request(reviews_url);

    if (
      !reviews ||
      !reviews.data ||
      !reviews.data.length
    ) {
      await removeLabel(octokit, label);
      return;
    }

    let lastReviews = [];
    reviews.data.filter(review => !["COMMENTED"].includes(review.state)).forEach((review) => {
      const reviewDate = review.submitted_at;
      const reviewAuthor = review.user.login;
      const reviewStatus = review.state;
      const currentReview = lastReviews.filter((item) => item.name === reviewAuthor)[0];

      core.info(`I found a review: ${reviewAuthor} ${reviewDate} ${reviewStatus}`);

      if (!currentReview || new Date(currentReview.date).getTime() < new Date(reviewDate).getTime()) {
        lastReviews = lastReviews.filter((item) => item.name !== reviewAuthor);
        lastReviews.push({
            name: reviewAuthor,
            date: reviewDate,
            state: reviewStatus,
          });
      }
    });

    let counter = 0;

    /*const payload = JSON.stringify(context.payload, undefined, 2)
    console.log(`The event payload: ${payload}`);*/

    async function asyncForEach(array, callback) {
      for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
      }
    }

    await asyncForEach(lastReviews, async (review) => {
      const reviewer_url = `${context.payload.organization.url}/teams/${leaddevTeamId}/members/${review.name}`;
      try {
        const reviewer = await octokit.request(reviewer_url);
        if (null !== reviewer) counter += 1;
      } catch (e) {
        // Member is not on team
      }
    });

    if (!counter) {
      throw new Error(":bulb: release-ready: this PR must be reviewed by at least 1 lead dev.");
    }

    if (
      !lastReviews.length ||
      lastReviews.filter(review => "APPROVED" !== review.state).length
    ) {
      const waitingReviewers = lastReviews
        .filter(review => "APPROVED" !== review.state)
        .map(review => review.name);
      core.info(`Reviewers: ${waitingReviewers}`);
      throw new Error(":bulb: release-ready: this PR is not fully approved yet.");
    }

    if (requiredChecks) {
      const requiredChecksArray = requiredChecks.split(',');

      await asyncForEach(requiredChecksArray, async (check) => {
        const listForRef = await octokit.checks.listForRef({
          check_name: check,
          owner: context.repo.owner,
          repo: context.repo.repo,
          ref: context.payload.pull_request.head.sha || context.sha,
        });

        if (!listForRef || !listForRef.data.total_count) {
          throw new Error(`:x: release-ready: check ${check} is required and must be run.`);
        }

        const completedCheck = listForRef.data.check_runs.find(
          checkRun => checkRun.status === 'completed' && checkRun.conclusion === 'success'
        );

        if (!completedCheck) {
          throw new Error(`:bulb: release-ready: check '${check}' is required and must be successful.`);
        }
        });
    }

    /*
    const status = await octokit.repos.getCombinedStatusForRef({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: context.payload.pull_request.head.sha || context.sha,
    });

    if (!status || status.data.state !== 'success') {
      throw new Error(`:bulb: release-ready: PR status is not successful yet.`);
    }
    */

    await ghCreateComment(octokit, ":heavy_check_mark: release-ready: this PR can be released.");
    core.info("OK! Adding label to PR!");

    await ghAddLabels(octokit, [label]);
  } catch (e) {
    await removeLabel(octokit, label);


    await ghCreateComment(octokit, e.message);
    core.info(e.message);
  }
}

run();
