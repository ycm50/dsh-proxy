// Registers the primitives stub hook for the client-half smoke test.
import { register } from 'node:module'

register(new URL('./primitives-hook.mjs', import.meta.url))
