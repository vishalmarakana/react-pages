import React from 'react'
import ReactDOM from 'react-dom/server'
import createStringStream from 'string-to-stream'
import combineStreams from 'multistream'

import { render_before_content, render_after_content } from './html'
import normalizeSettings from '../redux/normalize'
import timer from '../timer'
import { getLocationUrl, parseLocation } from '../location'
import reduxRender from '../redux/server/render'
import { initialize as reduxInitialize } from '../redux/server/server'
import { generateMetaTagsMarkup } from '../meta/meta'

export default async function(settings, {
	initialize,
	assets,
	proxy,
	url,
	renderContent,
	html = {},
	cookies,
	locales
})
{
	settings = normalizeSettings(settings)

	const {
		routes,
		container,
		authentication,
		onError
	} = settings

	// If Redux is being used, then render for Redux.
	// Else render for pure React.
	const render = reduxRender

	// Read protected cookie value (if configured)
	let protected_cookie_value
	if (authentication && authentication.protectedCookie) {
		protected_cookie_value = cookies.get(authentication.protectedCookie)
	}

	const initializeTimer = timer()

	// `parameters` are used for `assets` and `html` modifiers.
	// , afterwards
	const {
		cookies: cookiesToSet,
		generateJavascript,
		...parameters
	} = await reduxInitialize(settings, {
		protected_cookie_value,
		proxy,
		cookies,
		initialize,
		url
	})

	const location = parseLocation(url)
	const path = location.pathname

	// The above code (server-side `initialize()` method call) is not included
	// in this `try/catch` block because:
	//
	//  * `parameters` are used inside `.error()`
	//
	//  * even if an error was caught inside `initialize()`
	//    and a redirection was performed, say, to an `/error` page
	//    then it would fail again because `initialize()` would get called again,
	//    so wrapping `initialize()` with `try/catch` wouldn't help anyway.
	//
	try {
		const initializeTime = initializeTimer()

		// Internationalization

		function generateOuterHtml(meta)
		{
			// `html` modifiers
			let { head, bodyStart, bodyEnd } = html

			// Normalize `html` parameters
			head = typeof head === 'function' ? head(path, parameters) : head
			bodyStart = typeof bodyStart === 'function' ? bodyStart(path, parameters) : bodyStart
			bodyEnd = typeof bodyEnd === 'function' ? bodyEnd(path, parameters) : bodyEnd

			// Normalize assets
			assets = typeof assets === 'function' ? assets(path, parameters) : assets

			if (!assets.entries) {
				// Default `assets.entries` to `["main"]`.
				if (assets.javascript && assets.javascript.main) {
					assets.entries = ['main']
				} else {
					throw new Error(`"assets.entries[]" configuration parameter is required: it includes all Webpack "entries" for which javascripts and styles must be included on a server-rendered page. If you didn't set up any custom "entries" in Webpack configuration then the default Webpack entry is called "main". You don't seem to have the "main" entry so the server doesn't know which assets to include on the page ("['main']" is the default value for "assets.entries").`)
				}
			}

			// Preferred locale.
			const locale = locales[0]

			// Render all HTML that goes before React markup.
			const before_content = render_before_content
			({
				assets,
				locale,
				meta: generateMetaTagsMarkup(meta).join(''),
				head,
				bodyStart
			})

			// Render all HTML that goes after React markup
			const after_content = render_after_content
			({
				javascript: generateJavascript(),
				assets,
				locale,
				bodyEnd,
				protected_cookie_value,
				contentNotRendered: renderContent === false
			})

			return [ before_content, after_content ]
		}

		// A special `base.html` page for static sites.
		// (e.g. the ones hosted on Amazon S3)
		if (path.replace(/\/$/, '') === '/react-website-base')
		{
			renderContent = false

			const [ before_content, after_content ] = generateOuterHtml({})

			return {
				route: '/react-website-base',
				status: 200,
				content: createStringStream(before_content + after_content),
				cookies: []
			}
		}

		// Render the page.
		const {
			redirect,
			route,
			status,
			content,
			meta,
			containerProps,
			time
		} = await render({
			...parameters,
			routes
		})

		if (redirect) {
			return {
				redirect: normalizeRedirect(redirect, settings.basename)
			}
		}

		const [ before_content, after_content ] = generateOuterHtml(meta)

		const streams =
		[
			createStringStream(before_content),
			createStringStream(after_content)
		]

		if (renderContent !== false)
		{
			// Render page content to a `Stream`
			// inserting this stream in the middle of `streams` array.
			// `array.splice(index, 0, element)` inserts `element` at `index`.
			const pageElement = React.createElement(container, containerProps, content)
			streams.splice(streams.length / 2, 0, ReactDOM.renderToNodeStream(pageElement))
		}

		return {
			route,
			status,
			content: combineStreams(streams),
			time: {
				...time,
				initialize: initializeTime
			},
			cookies: cookiesToSet
		}
	}
	catch (error)
	{
		if (onError)
		{
			let redirect

			const onErrorParameters = {
				server : true,
				path,
				url : getLocationUrl(location),
				redirect : (to) => {
					// Only the first redirect takes effect on the server side
					if (!redirect) {
						redirect = parseLocation(to)
					}
				},
				// Special case for Redux
				getState : parameters.store.getState
			}

			onError(error, onErrorParameters)

			// Either redirects or throws the error.
			if (redirect) {
				return {
					redirect: normalizeRedirect(redirect, settings.basename)
				}
			}
		}

		throw error
	}
}

function normalizeRedirect(redirect, basename) {
	// Stringify `redirect` location.
	// Prepend `basename` to relative URLs for server-side redirect.
	return getLocationUrl(redirect, { basename })
}