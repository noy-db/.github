import { defineUnlock } from '@noy-db/hub/on'
import { NoydbError } from '@noy-db/hub'
import type { Vault } from '@noy-db/hub/introspection'
export type Bound = Vault
export const onUsesHub = defineUnlock({ name: 'uses', error: NoydbError })
