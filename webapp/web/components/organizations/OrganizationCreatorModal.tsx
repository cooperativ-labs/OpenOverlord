import { OrganizationOnboardingForm } from '@/components/setup/OrganizationOnboardingForm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';

type OrganizationCreatorModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Founding a new organization reuses the same onboarding form as the zero-
 * membership boot screen. The server rejects callers who already have
 * memberships (409) until a dedicated multi-org creation path exists.
 */
export function OrganizationCreatorModal({ open, onOpenChange }: OrganizationCreatorModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create organization</DialogTitle>
          <DialogDescription>
            Start a new organization with its first workspace. If you already belong to a workspace,
            you may need to leave it first.
          </DialogDescription>
        </DialogHeader>
        <OrganizationOnboardingForm onSuccess={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
