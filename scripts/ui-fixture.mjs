import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { root } from './verification.mjs'

export const uiRequire = createRequire(new URL('../tools/ui/package.json', import.meta.url))

export async function mountFixture(page) {
  await page.clock.install()
  await page.setContent(`<!doctype html><html lang="en"><head><style>
    :root{--dsw-alias-label-primary:#111;--dsw-alias-label-secondary:#555;--dsw-alias-label-tertiary:#777;--dsw-alias-bg-overlay:#fff;--dsw-alias-bg-layer-2:#fafafa;--dsw-alias-border-l1:#ddd;--dsw-alias-border-l2:#ccc}
    body{font:14px sans-serif;margin:0}#shell{position:fixed;left:56px;right:8px;bottom:24px;height:340px;overflow:auto}
    #root{position:absolute;bottom:16px;left:16px;right:16px}
  </style></head><body><div id="shell"><div id="root"></div></div></body></html>`)
  for (const name of ['react', 'react-dom']) {
    const folder = dirname(uiRequire.resolve(name + '/package.json'))
    await page.addScriptTag({ path: join(folder, 'umd', name + '.development.js') })
  }
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load(spec) { window.slpComponents = spec.factory(name => {
      if (name !== 'react') throw new Error('Unexpected fixture dependency: ' + name)
      return window.React
    }) } }
  })
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  if (!source.includes('return module.exports')) throw new Error('Client factory format changed; update UI fixture adapter')
  await page.addScriptTag({ content: source.replace('return module.exports', 'return { ActivityRow, CostRow, CSS }') })
  await page.evaluate(() => {
    const { React, ReactDOM, slpComponents: components } = window
    const style = document.createElement('style'); style.textContent = components.CSS; document.head.appendChild(style)
    const part = (amount, tokens) => ({ amountUsd: amount, minUsd: amount, maxUsd: amount, tokensUsd: tokens })
    const cost = { session: { ...part(10, 0), pricedMessages: 1, unpricedMessages: 0, sources: { 'pi-ai': 1 }, reasons: {},
      breakdown: { input: part(2, 12000), cache: part(3, 1000700), output: part(5, 200) } },
      catalog: { version: 'fixture', generatedAt: 1790105504346 } }
    const catalog = [{ id: 'one', label: 'Worker 1', mode: 'continuable' }, { id: 'two', label: 'Worker 2', mode: 'one-shot' }]
    const state = { ids: ['one', 'two'], projectionsBySession: Object.fromEntries(catalog.map(child => [child.id, { values: {
      modelSelection: { lastUsed: { model: 'fixture-model', reasoningEffort: 'high' }, next: { model: 'pending-model', reasoningEffort: 'max' } },
      subagentTiming: { settledMs: 12000, active: null },
    } }])) }
    function App() {
      const [running, setRunning] = React.useState([true, true])
      window.setChildRunning = (index, value) => setRunning(previous => previous.map((item, n) => n === index ? value : item))
      return React.createElement('div', { className: 'slp-row' },
        React.createElement(components.ActivityRow, { sessionId: 'fixture-parent', useProjection: () => catalog,
          useSessions: select => select(state), useSessionStatus: select => select(new Map(catalog.map((child, index) => [child.id, { running: running[index] }]))) }),
        React.createElement(components.CostRow, { useProjection: () => cost }))
    }
    window.slpFixtureRoot = ReactDOM.createRoot(document.getElementById('root'))
    window.slpFixtureRoot.render(React.createElement(App))
  })
}
