import type { DiscoverProps } from './discoverControllerTypes';
import DiscoverView from './DiscoverView';
import { useDiscoverController } from './useDiscoverController';

export default function DiscoverPanel(props: DiscoverProps) {
  return <DiscoverView controller={useDiscoverController(props)} />;
}
