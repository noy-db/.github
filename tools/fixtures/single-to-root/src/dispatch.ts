import { defineStore } from '@noy-db/hub/to'
// hub's own contract (#935) requires this predicate, and /to does not export
// it — which is why doi-db's ALLOWED_HUB carries the root barrel.
import { isConflictError } from '@noy-db/hub'
export const dispatch = () => (isConflictError(null) ? null : defineStore({ name: 'd' }))
