import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { SettingsPage } from '../pages/SettingsPage';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});
