/**
 * Ambient declarations for the browser client bundle.
 *
 * `*.module.css` is compiled by the bundle's own lightningcss plugin
 * (`tsdown.config.ts`), which replaces the import with the hashed class map —
 * so the type side only needs to say that it is a string map.
 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
