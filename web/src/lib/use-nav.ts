"use client";

import { useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTopLoader } from "nextjs-toploader";

// useNav：包一层 next/navigation 的 router，编程式跳转前先点亮顶部进度条（NextTopLoader）。
//
// 背景：nextjs-toploader 只在 <a> / <Link> 被点击时自动 start() 进度条；它对 history.pushState
// 的 patch 只调用 done()（结束）。所以「按钮 onClick 里 router.push(...)」这类编程式跳转
// 不会触发进度条。凡是「点按钮跳到另一个页面」都应该用这个 nav 而不是裸 router.push。
//
// ⚠️ 注意：同页 URL 同步（比如 /image 里 router.replace 到 /image/{id} 而组件不卸载）不要用它，
// 否则会闪一下进度条误导用户——那种保持用裸 router.replace。
//
// 返回的对象引用稳定（useMemo + router 依赖；router 由 next/navigation 保证稳定），
// 可以安全放进 useCallback / useEffect 的依赖数组，不会因为它变化而反复重建。
export function useNav() {
  const router = useRouter();
  const loader = useTopLoader();
  // loader 每次渲染是新对象，用 ref 存最新引用，避免进 useMemo 依赖导致每次重建。
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  return useMemo(
    () => ({
      push: (href: string) => {
        loaderRef.current.start();
        router.push(href);
      },
      replace: (href: string) => {
        loaderRef.current.start();
        router.replace(href);
      },
      back: () => {
        loaderRef.current.start();
        router.back();
      },
    }),
    [router],
  );
}
