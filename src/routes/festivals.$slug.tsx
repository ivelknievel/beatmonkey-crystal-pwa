import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { FestivalDetailPage } from '../pages/FestivalDetailPage';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/festivals/$slug',
  component: FestivalDetailPage,
});
