import type { Metadata } from "next";
import NextTopLoader from "nextjs-toploader";
import { AntThemeProvider } from "@/components/ant-theme-provider";
import { QueryProvider } from "@/components/query-provider";
import { ThemeSync } from "@/components/theme-sync";
import { UserSessionSync } from "@/components/user-session-sync";
import "antd/dist/reset.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "无限画布",
  description: "一个无限画布创作工具",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className="font-sans">
      <body
        className="bg-background text-foreground antialiased"
        style={{
          fontFamily:
            '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif',
        }}
      >
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var s=JSON.parse(localStorage.getItem("infinite-canvas:theme_store")||"{}");var t=s.state&&s.state.theme==="light"?"light":"dark";document.documentElement.classList.toggle("dark",t==="dark");document.documentElement.style.colorScheme=t}catch(e){}`,
          }}
        />
        {/* 全局路由跳转进度条：点菜单 / Link 时立刻出现顶部蓝色细条，
            等 Next.js App Router 路由切完才消失。比纯 spinner 更轻量，
            用户感知到「点了有反应」。height/color 走主色调，跟 ant primary 一致。 */}
        <NextTopLoader
          color="#1677ff"
          height={3}
          showSpinner={false}
          shadow="0 0 8px #1677ff,0 0 4px #1677ff"
        />
        <ThemeSync />
        <AntThemeProvider>
          <QueryProvider>
            <UserSessionSync />
            {children}
          </QueryProvider>
        </AntThemeProvider>
      </body>
    </html>
  );
}
