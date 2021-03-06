import * as Sentry from '@sentry/node'
import { URL } from 'url'
import { IncomingMessage, RequestListener } from '../extra'
import { decodePayload, IN_PRODUCTION_MODE, logRequestOnError, sentryDSN } from './config'
import { log } from './db'

Sentry.init({
  dsn: sentryDSN,
  environment: IN_PRODUCTION_MODE ? 'production' : 'development',
})

export type Route = {
  path: string
  handler?: RequestListener
}

export type RouteHandler<T = ExpectedAny> = (
  req: IncomingMessage,
  data: ExpectedAny,
) => Promise<T> | T

export const getURL = (req: IncomingMessage) => new URL(`https://${req.headers.host}${req.url}`)

const wwwFormParser = (body: string) =>
  body
    .split('&')
    .map(pair => pair.split('='))
    .map(pair => pair.map(decodeURIComponent))
    .reduce(
      (merged, [key, value]) => {
        if (key in merged) {
          if (Array.isArray(merged[key])) (merged[key] as string[]).push(value)
          else merged[key] = [merged[key] as string, value]
        } else merged[key] = value

        return merged
      },
      {} as {
        [key: string]: string | string[]
      },
    )

const getContentParser = (req: IncomingMessage) => {
  switch (req.headers['content-type']) {
    case 'application/x-www-form-urlencoded':
      return wwwFormParser
    case 'application/json':
      return JSON.parse
    default:
      return <T>(_: T) => _
  }
}

const getRequestBody = (req: IncomingMessage) => {
  return new Promise<string>((resolve, reject) => {
    const bodyBuffer: string[] = []
    req.on('data', data => bodyBuffer.push(data.toString()))
    req.on('end', async () => {
      const body = bodyBuffer.join('')
      resolve(body)
    })
    req.on('error', reject)
  })
}

async function parseContent(req: IncomingMessage) {
  const body = await getRequestBody(req)
  const parser = getContentParser(req)
  const data = parser(body)
  return data
}

export const requestHandler: (handler: RouteHandler) => RequestListener = handler => async (
  req,
  res,
) => {
  let data: ExpectedAny
  let result
  try {
    data = await parseContent(req)
    result = await handler(req, data)
    res.end(result ? JSON.stringify(result) : undefined)
  } catch (err) {
    console.error(err)
    if (decodePayload) {
      if (typeof data === 'object' && data !== null && typeof data.payload === 'string') {
        try {
          data.payload = JSON.parse(decodeURIComponent(data.payload))
        } catch (err) {}
      }
    }
    if (logRequestOnError) {
      const logRef = await log({
        time: new Date().toLocaleString('US'),
        path: req.url,
        info: String(err),
        data,
      })
      Sentry.withScope(scope => {
        scope.setExtra('path', req.url)
        scope.setExtra('data', data)
        scope.setExtra('firebase-log-key', logRef.key)
        Sentry.captureException(err)
      })
    } else {
      console.log('not logging above error to db')
    }
    res.writeHead(400)
    res.end(String(err))
  }
}
