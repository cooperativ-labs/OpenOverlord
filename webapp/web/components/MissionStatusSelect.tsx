import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { useUpdateMission } from '@/lib/queries.ts';

import type { WorkspaceStatusDto } from '../../shared/contract.ts';

type MissionStatusSelectProps = {
  missionId: string;
  currentStatusId: string;
  statuses: WorkspaceStatusDto[];
};

export function MissionStatusSelect({
  missionId,
  currentStatusId,
  statuses
}: MissionStatusSelectProps) {
  const update = useUpdateMission(missionId);
  const currentStatus = statuses.find(status => status.id === currentStatusId);

  function handleChange(nextStatusId: string | null) {
    if (!nextStatusId || nextStatusId === currentStatusId) return;
    update.mutate({ statusId: nextStatusId });
  }

  return (
    <Select value={currentStatusId} disabled={update.isPending} onValueChange={handleChange}>
      <SelectTrigger
        id="mission-status-select"
        aria-label="Select status"
        size="sm"
        className="h-6 w-auto rounded-md border bg-transparent px-3 text-xs font-base hover:bg-muted"
      >
        <SelectValue>{currentStatus?.name ?? 'Status'}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {statuses.map(status => (
          <SelectItem key={status.id} value={status.id}>
            {status.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
