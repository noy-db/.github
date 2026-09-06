import { adoptPartition } from '@noy-db/hub/cargo'
import { openPod } from '@noy-db/hub/pod'
export const a = () => openPod(adoptPartition())
