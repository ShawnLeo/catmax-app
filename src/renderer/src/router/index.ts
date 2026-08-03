import { useAuthStore } from '@renderer/stores/auth'
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
  {
    path: '/login',
    name: 'login',
    component: () => import('@renderer/views/LoginView.vue'),
  },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

/**
 * 内测登录守卫：未登录时所有路由都被拦截到 /login；已登录时访问 /login 放行回欢迎页。
 *
 * ensureInitialized() 缓存了首次 getStatus 的 promise，因此每次导航 await
 * 不会重复发起 IPC——只有 app 启动后第一次真实请求一次主进程登录态。
 * 登录态在主进程落盘，所以重启 app 后这里能直接读到"记住登录"的结果。
 */
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  await auth.ensureInitialized()
  if (!auth.loggedIn && to.name !== 'login') {
    return { name: 'login' }
  }
  if (auth.loggedIn && to.name === 'login') {
    return { name: 'welcome' }
  }
  return true
})
