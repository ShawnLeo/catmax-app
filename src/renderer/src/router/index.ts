import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'welcome',
    component: () => import('@renderer/views/WelcomeView.vue'),
  },
  {
    path: '/chat',
    name: 'chat',
    component: () => import('@renderer/views/ChatView.vue'),
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@renderer/views/SettingsView.vue'),
  },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})
