import { isDownloadTaskActive } from '../../shared/state/modelDownloadTask';
import { finishTask, getTaskSnapshot, type AppTask } from '../../shared/state/taskRegistry';
import type { TransferCancel } from './discoverControllerTypes';

export const findDownloadTask = (taskId: string): AppTask | undefined =>
  getTaskSnapshot().find((task) => task.id === taskId);

export const hasActiveDownloadMatching = (predicate: (task: AppTask) => boolean): boolean =>
  getTaskSnapshot().some(
    (task) => task.kind === 'model-download' && isDownloadTaskActive(task) && predicate(task),
  );

export const ownsTransferTask = (taskId: string, cancelToken: TransferCancel | null): boolean =>
  cancelToken !== null && findDownloadTask(taskId)?.cancel === cancelToken;

export const finishTransferTask = (
  taskId: string,
  cancelToken: TransferCancel | null,
  state: 'completed' | 'cancelled' | 'failed',
  detail?: string,
) => {
  if (ownsTransferTask(taskId, cancelToken)) finishTask(taskId, state, detail);
};
