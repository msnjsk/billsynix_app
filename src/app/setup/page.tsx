import { SetupWizard } from '@/components/setup/SetupWizard';

export const metadata = {
  title: 'Set up your store',
};

/** First-run setup. Every other page sends an un-set-up computer here. */
export default function SetupPage() {
  return <SetupWizard />;
}
