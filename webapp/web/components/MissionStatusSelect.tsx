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
        className="h-[22px] w-auto rounded-full border-border/50 bg-transparent px-2.5 text-[11px] font-normal text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground"
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
