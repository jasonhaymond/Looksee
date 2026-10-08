"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "../lib/api";

// Redirects to /login on a 401; returns true once the session is confirmed.
export function usePageAuth() {
  const router = useRouter();
  const [ok, setOk] = useState(false);
  useEffect(() => {
    api
      .me()
      .then(() => setOk(true))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.push("/login");
      });
  }, [router]);
  return ok;
}
