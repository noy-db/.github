import { defineFormat } from '@noy-db/hub/as'
import { isConflictError } from '@noy-db/hub'
import type { StoreContract } from '@noy-db/hub/to'
export type Bound = StoreContract
export const asGood = defineFormat({ name: 'good', guard: isConflictError })
