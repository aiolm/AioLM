import { MODEL_DOWNLOAD_TASK_ID } from '../../shared/state/modelDownloadTask';
import { finishTask, getTaskSnapshot } from '../../shared/state/taskRegistry';
import type { TransferCancel } from './discoverControllerTypes';

export const transferActive = () => getTaskSnapshot().some(task => task.id === MODEL_DOWNLOAD_TASK_ID && ['running', 'cancelling'].includes(task.state));
export const currentTransferTask = () => getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID);
export const ownsTransferTask = (cancelToken: TransferCancel | null) => cancelToken !== null
  && currentTransferTask()?.cancel === cancelToken;
export const finishTransferTask = (cancelToken: TransferCancel | null, state: 'completed' | 'cancelled' | 'failed', detail?: string) => {
  if (ownsTransferTask(cancelToken)) finishTask(MODEL_DOWNLOAD_TASK_ID, state, detail);
};
