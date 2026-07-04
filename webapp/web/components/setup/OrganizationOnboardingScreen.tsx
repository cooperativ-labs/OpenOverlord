import { OrganizationOnboardingForm } from '@/components/setup/OrganizationOnboardingForm';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function OrganizationOnboardingScreen() {
  return (
    <div className="flex h-dvh items-center justify-center overflow-y-auto bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Welcome to Overlord</CardTitle>
          <CardDescription>
            Create your organization and first workspace. You can invite teammates and add more
            workspaces later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrganizationOnboardingForm />
        </CardContent>
      </Card>
    </div>
  );
}
