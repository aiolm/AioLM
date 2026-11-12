import ProjectsView from "./ProjectsView";
import { useProjectsController, type ProjectsPanelProps } from "./useProjectsController";

export default function ProjectsPanel(props: ProjectsPanelProps) {
  const controller = useProjectsController(props);
  return <ProjectsView controller={controller} />;
}
