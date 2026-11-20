// The notification service's status (connected, retrying, stopped…), kept
// current while a screen shows it: updated by the service's own events, and
// re-read every 5 seconds in case an event was missed.

import { useEffect, useState } from "react";
import * as Stream from "../../modules/looksee-stream";

export function useStreamStatus() {
  const [status, setStatus] = useState(Stream.getStatus());
  useEffect(() => {
    const sub = Stream.onStatus(setStatus);
    const timer = setInterval(() => setStatus(Stream.getStatus()), 5000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, []);
  return status;
}
