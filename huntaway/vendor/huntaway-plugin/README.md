# @huntaway/plugin (vendored)

A copy of Huntaway's plugin API, `packages/plugin/src` in dire-kiwi/huntaway at commit 3758e66 (HE-34), without its
example. The docs plugin type-checks and tests against it. It is only a development dependency: on the board the plugin
imports the board's own `@huntaway/plugin` (a peer dependency), so its `PluginHost`, `PluginError` and the rest are the
board's.

Replace it with the published package once Huntaway ships `@huntaway/plugin` as a tarball (docs/plan/15-plugins.md,
What's next).
