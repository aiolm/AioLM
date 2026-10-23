import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { afterInitialLayout, currentLayoutRead } from "./initialLayout";

const InitialSurfaceReady = createContext(true);
export const useInitialSurfaceReady = () => useContext(InitialSurfaceReady);

export function SurfaceLoading() {
  return <div className="surface-loading" role="status" aria-label="AioLM"><span className="panel-spinner" aria-hidden="true" /></div>;
}

/** The region retains its final dimensions while its data is prepared. */
export default function InitialSurface({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const ancestorReady = useInitialSurfaceReady();
  // A slow read in an already mounted page must not block navigation elsewhere.
  const [afterRead] = useState(currentLayoutRead);
  useLayoutEffect(() => afterInitialLayout(() => setReady(true), undefined, undefined, afterRead), [afterRead]);
  return <InitialSurfaceReady.Provider value={ancestorReady && ready}><div className="initial-surface" aria-busy={!ready}>
    <div className="initial-surface-content" inert={!ready} data-ready={ready}>{children}</div>
    {!ready && <SurfaceLoading />}
  </div></InitialSurfaceReady.Provider>;
}
