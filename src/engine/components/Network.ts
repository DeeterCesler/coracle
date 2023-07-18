import {EventEmitter} from "events"
import {verifySignature, matchFilters} from "nostr-tools"
import {Pool, Plex, Relays, Executor, Socket} from "paravel"
import {ensurePlural} from "hurdak/lib/hurdak"
import {union, difference} from "src/util/misc"
import {warn, error, log} from "src/util/logger"
import {normalizeRelayUrl} from "src/util/nostr"
import type {Event, Filter} from "src/engine/types"
import {Cursor, MultiCursor} from "src/engine/util/Cursor"
import {Subscription} from "src/engine/util/Subscription"
import {Feed} from "src/engine/util/Feed"

export type SubscribeOpts = {
  relays: string[]
  filter: Filter[] | Filter
  onEvent?: (event: Event) => void
  onEose?: (url: string) => void
  timeout?: number
  shouldProcess?: boolean
}

const getUrls = relays => {
  if (relays.length === 0) {
    error(`Attempted to connect to zero urls`)
  }

  const urls = new Set(relays.map(normalizeRelayUrl))

  if (urls.size !== relays.length) {
    warn(`Attempted to connect to non-unique relays`)
  }

  return Array.from(urls)
}

export class Network {
  static contributeState() {
    const authHandler = null
    const emitter = new EventEmitter()
    const pool = new Pool()

    return {authHandler, emitter, pool}
  }

  static contributeSelectors({Network}) {
    const relayHasError = url => Boolean(Network.pool.get(url, {autoConnect: false})?.error)

    return {relayHasError}
  }

  static contributeActions(engine) {
    const {Network, User, Events, Nip65, Env} = engine

    const getExecutor = (urls, {bypassBoot = false} = {}) => {
      if (Env.FORCE_RELAYS?.length > 0) {
        urls = Env.FORCE_RELAYS
      }

      let target

      const muxUrl = User.getSetting("multiplextr_url")

      // Try to use our multiplexer, but if it fails to connect fall back to relays. If
      // we're only connecting to a single relay, just do it directly, unless we already
      // have a connection to the multiplexer open, in which case we're probably doing
      // AUTH with a single relay.
      if (muxUrl && (urls.length > 1 || Network.pool.has(muxUrl))) {
        const socket = Network.pool.get(muxUrl)

        if (!socket.error) {
          target = new Plex(urls, socket)
        }
      }

      if (!target) {
        target = new Relays(urls.map(url => Network.pool.get(url)))
      }

      const executor = new Executor(target)

      executor.handleAuth({
        onAuth(url, challenge) {
          Network.emitter.emit("error:set", url, "unauthorized")

          return Network.authHandler?.(url, challenge)
        },
        onOk(url, id, ok, message) {
          Network.emitter.emit("error:clear", url, ok ? null : "forbidden")

          // Once we get a good auth response don't wait to send stuff to the relay
          if (ok) {
            Network.pool.get(url)
            Network.pool.booted = true
          }
        },
      })

      // Eagerly connect and handle AUTH
      executor.target.sockets.forEach(socket => {
        const {limitation} = Nip65.getRelayInfo(socket.url)
        const waitForBoot = limitation?.payment_required || limitation?.auth_required

        // This happens automatically, but kick it off anyway
        socket.connect()

        // Delay REQ/EVENT until AUTH flow happens. Highly hacky, as this relies on
        // overriding the `shouldDeferWork` property of the socket. We do it this way
        // so that we're not blocking sending to all the other public relays
        if (!bypassBoot && waitForBoot && socket.status === Socket.STATUS.PENDING) {
          socket.shouldDeferWork = () => {
            return socket.booted && socket.status !== Socket.STATUS.READY
          }

          setTimeout(() => Object.assign(socket, {booted: true}), 2000)
        }
      })

      return executor
    }

    const publish = ({relays, event, onProgress, timeout = 3000, verb = "EVENT"}) => {
      const urls = getUrls(relays)
      const executor = getExecutor(urls, {bypassBoot: verb === "AUTH"})

      Network.emitter.emit("publish", urls)

      log(`Publishing to ${urls.length} relays`, event, urls)

      return new Promise(resolve => {
        const timeouts = new Set()
        const succeeded = new Set()
        const failed = new Set()

        const getProgress = () => {
          const completed = union(timeouts, succeeded, failed)
          const pending = difference(urls, completed)

          return {succeeded, failed, timeouts, completed, pending}
        }

        const attemptToResolve = () => {
          const progress = getProgress()

          if (progress.pending.size === 0) {
            log(`Finished publishing to ${urls.length} relays`, event, progress)
            resolve(progress)
            sub.unsubscribe()
            executor.target.cleanup()
          } else if (onProgress) {
            onProgress(progress)
          }
        }

        setTimeout(() => {
          for (const url of urls) {
            if (!succeeded.has(url) && !failed.has(url)) {
              timeouts.add(url)
            }
          }

          attemptToResolve()
        }, timeout)

        const sub = executor.publish(event, {
          verb,
          onOk: url => {
            succeeded.add(url)
            timeouts.delete(url)
            failed.delete(url)
            attemptToResolve()
          },
          onError: url => {
            failed.add(url)
            timeouts.delete(url)
            attemptToResolve()
          },
        })

        // Report progress to start
        attemptToResolve()
      })
    }

    const subscribe = ({
      relays,
      filter,
      onEose,
      onEvent,
      timeout,
      shouldProcess = true,
    }: SubscribeOpts) => {
      const urls = getUrls(relays)
      const executor = getExecutor(urls)
      const filters = ensurePlural(filter)
      const subscription = new Subscription()
      const now = Date.now()
      const seen = new Map()
      const eose = new Set()

      log(`Starting subscription with ${relays.length} relays`, {filters, relays})

      Network.emitter.emit("sub:open", urls)

      subscription.on("close", () => {
        sub.unsubscribe()
        executor.target.cleanup()
        Network.emitter.emit("sub:close", urls)
      })

      if (timeout) {
        setTimeout(subscription.close, timeout)
      }

      const sub = executor.subscribe(filters, {
        onEvent: (url, event) => {
          const seen_on = seen.get(event.id)

          if (seen_on) {
            if (!seen_on.includes(url)) {
              seen_on.push(url)
            }

            return
          }

          Object.assign(event, {
            seen_on: [url],
            content: event.content || "",
          })

          seen.set(event.id, event.seen_on)

          try {
            if (!verifySignature(event)) {
              return
            }
          } catch (e) {
            console.error(e)

            return
          }

          if (!matchFilters(filters, event)) {
            return
          }

          Network.emitter.emit("event", {url, event})

          if (shouldProcess) {
            Events.queue.push(event)
          }

          onEvent?.(event)
        },
        onEose: url => {
          onEose?.(url)

          // Keep track of relay timing stats, but only for the first eose we get
          if (!eose.has(url)) {
            Network.emitter.emit("eose", url, Date.now() - now)
          }

          eose.add(url)

          if (timeout && eose.size === relays.length) {
            subscription.close()
          }
        },
      })

      return subscription
    }

    const count = async filter => {
      const filters = ensurePlural(filter)
      const executor = getExecutor(Env.COUNT_RELAYS)

      return new Promise(resolve => {
        const sub = executor.count(filters, {
          onCount: (url, {count}) => resolve(count),
        })

        setTimeout(() => {
          resolve(0)
          sub.unsubscribe()
          executor.target.cleanup()
        }, 3000)
      })
    }

    const cursor = opts => new Cursor({...opts, subscribe})

    const multiCursor = ({relays, ...opts}) =>
      new MultiCursor(relays.map(relay => cursor({relay, ...opts})))

    const feed = opts => new Feed({engine, ...opts})

    return {subscribe, publish, count, cursor, multiCursor, feed}
  }
}