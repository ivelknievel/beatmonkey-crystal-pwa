import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { DJDetailPage } from '../pages/DJDetailPage';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/djs/$id',
  component: DJDetailPage,
});
