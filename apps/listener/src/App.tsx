import { LiveExperience } from './LiveExperience';

export function App() {
  return (
    <LiveExperience apiBase={import.meta.env.VITE_PROCESSOR_PUBLIC_URL ?? window.location.origin} />
  );
}
