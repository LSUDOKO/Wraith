"use client";

import { Alerts } from "@/app/components/Alerts";
import { ActivityLog } from "@/app/components/ActivityLog";
import { useWraith, WRAITH_ADDRESS } from "../WraithContext";

export default function ActivityPage() {
  const { account } = useWraith();

  return (
    <>
      <Alerts address={account} />
      <ActivityLog address={WRAITH_ADDRESS || undefined} />
    </>
  );
}
