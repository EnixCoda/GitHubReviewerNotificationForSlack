import { IncomingMessage } from '../extra'
import { getURL, RouteHandler } from './'
import { actions, botSpeak } from './bot'
import * as db from './db'

const GITHUB_EVENT_HEADER_KEY = 'X-GitHub-Event'

const GITHUB_EVENT_TYPES = {
  PING: 'ping',
  PULL_REQUEST: 'pull_request',
  PULL_REQUEST_REVIEW: 'pull_request_review',
}

const GITHUB_EVENT_ACTION_TYPES = {
  REVIEW_REQUESTED: 'review_requested',
  SUBMITTED: 'submitted',
}

const getHeader = (req: IncomingMessage, key: string) =>
  req.headers && (req.headers[key] || req.headers[key.toLowerCase()])

const getWorkspace = (req: IncomingMessage) => {
  const url = getURL(req)
  const workspace = url.searchParams.get('workspace')
  if (!workspace) throw Error(`no workspace provided`)
  return workspace
}

const menuForLinkingOthers = (githubName: string) => ({
  attachments: [
    {
      text: `If the user of ${githubName} is in this workspace, you can set up link for the user.`,
      fallback: 'Something went wrong.',
      callback_id: 'link_for_others',
      color: '#3AA3E3',
      attachment_type: 'default',
      actions: [
        {
          text: `Link for ${githubName}`,
          type: 'button',
          name: actions.linkOtherUser,
          value: JSON.stringify({ githubName }),
        },
      ],
    },
  ],
})

export const handleGitHubHook: RouteHandler = async (req, data) => {
  // handle application/x-www-form-urlencoded data
  if (data.payload) data = JSON.parse(data.payload)

  const workspace = getWorkspace(req)
  const type = getHeader(req, GITHUB_EVENT_HEADER_KEY)
  if (!type) throw Error(`no github event header provided`)
  switch (type) {
    case GITHUB_EVENT_TYPES.PING:
      return `I'm ready!`
    case GITHUB_EVENT_TYPES.PULL_REQUEST:
      if (data['action'] === GITHUB_EVENT_ACTION_TYPES.REVIEW_REQUESTED) {
        const pullRequest = data['pull_request']
        const requestedReviewer = data['requested_reviewer']
        const {
          user: { login: requesterGitHubName },
          html_url: pullRequestURL,
        } = pullRequest
        const { login: reviewerGitHubName } = requestedReviewer
        const [requesterUserID, reviewerUserID] = await Promise.all([
          gitHubNameToSlackID(workspace, requesterGitHubName),
          gitHubNameToSlackID(workspace, reviewerGitHubName),
        ])
        // I know below part is quite verbose, but I won't simplify
        if (reviewerUserID && requesterUserID) {
          // both registered
          const text = `🧐 ${requesterGitHubName}(<@${requesterUserID}>) requested code review from ${reviewerGitHubName}(<@${reviewerUserID}>):\n${pullRequestURL}`
          return Promise.all([
            botSpeak(workspace, requesterUserID, text),
            botSpeak(workspace, reviewerUserID, text),
          ]).then(() => true)
        } else if (reviewerUserID) {
          // only reviewer registered
          const text = `🧐 ${requesterGitHubName}(<@${requesterUserID}>) requested code review from ${reviewerGitHubName}(<@${reviewerUserID}>):\n${pullRequestURL}\n\nNote: ${requesterGitHubName} has not been linked to this workspace yet.`
          return botSpeak(
            workspace,
            reviewerUserID,
            text,
            menuForLinkingOthers(requesterGitHubName),
          )
        } else if (requesterUserID) {
          // only requestor registered
          const text = `🧐 ${requesterGitHubName}(<@${requesterUserID}>) requested code review from ${reviewerGitHubName}(<@${reviewerUserID}>):\n${pullRequestURL}\n\nNote: ${reviewerGitHubName} has not been linked to this workspace yet.`
          return botSpeak(
            workspace,
            requesterUserID,
            text,
            menuForLinkingOthers(reviewerGitHubName),
          )
        } else {
          console.log(`could not find users for`, requesterGitHubName, `and`, reviewerGitHubName)
        }
      } else {
        return 'unresolved action'
      }
    case GITHUB_EVENT_TYPES.PULL_REQUEST_REVIEW:
      switch (data.action) {
        case GITHUB_EVENT_ACTION_TYPES.SUBMITTED:
          const {
            pull_request: {
              user: { login: requesterGitHubName },
            },
            review: {
              state,
              html_url: reviewUrl,
              user: { login: reviewerGitHubName },
            },
          } = data
          if (reviewerGitHubName === requesterGitHubName) {
            // self comment, ignore
            return
          }
          const [requesterUserID, reviewerUserID] = await Promise.all([
            gitHubNameToSlackID(workspace, requesterGitHubName),
            gitHubNameToSlackID(workspace, reviewerGitHubName),
          ])
          if (!requesterUserID && !reviewerUserID) {
            console.log(
              `Could not find user for neither ${requesterGitHubName} nor ${reviewerGitHubName}`,
            )
          }
          if (state === 'approved') {
            // approvement message, notify requestor
            if (requesterUserID) {
              return botSpeak(
                workspace,
                requesterUserID,
                `🎉 Your pull request has been approved!\n${reviewUrl}`,
              )
            } else if (reviewerUserID) {
              // we could ask reviewer to introduce this app to PR requester here, but not now
            } else {
              throw new Error('impossible')
            }
          } else {
            // review message
            if (requesterUserID) {
              let text = `👏 ${requesterGitHubName}(<@${requesterUserID}>)'s pull request has been reviewed by ${reviewerGitHubName}(<@${reviewerUserID}>)\n${reviewUrl}`
              if (!reviewerUserID) {
                const linkNotify = (gitHubName: string) =>
                  `\n\nNote: ${gitHubName} has not been linked to this workspace yet.`
                text += linkNotify(reviewerGitHubName)
              }
              return botSpeak(workspace, requesterUserID, text)
            } else if (reviewerUserID) {
              // we could ask reviewer to introduce this app to PR requester here, but not now
            } else {
              throw new Error('impossible')
            }
          }
        default:
          return 'unresolved action'
      }
    default:
      return `no handler for this event type`
  }
}
function gitHubNameToSlackID(workspace: string, githubName: string): Promise<string | null> {
  return db
    .loadLinks(workspace, { github: githubName })
    .then(links => (links ? links[0].slack : null))
}
