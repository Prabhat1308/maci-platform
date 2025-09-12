import dynamic from "next/dynamic";

import { VotersList } from "~/features/voters/components/VotersList";
import ApproveVoters from "~/features/voters/components/ApproveVoters";
import { Layout } from "~/layouts/DefaultLayout";

const VotersPage = (): JSX.Element => (
  <Layout requireAuth>
    <div className="space-y-6 dark:text-white">
      <div>
        <h1 className="text-2xl font-semibold">Voters</h1>
        <p className="text-gray-500 dark:text-gray-300">Manage voter approvals via EAS</p>
      </div>

      <div className="flex items-center gap-4">
        <ApproveVoters />
      </div>

      <div>
        <h2 className="mb-2 text-xl font-medium">Approved voters</h2>
        <VotersList />
      </div>
    </div>
  </Layout>
);

export default dynamic(async () => Promise.resolve(VotersPage), { ssr: false });
