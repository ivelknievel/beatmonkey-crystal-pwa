import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { DiscoverPage } from '../pages/DiscoverPage';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/discover',
  component: DiscoverPage,
});
