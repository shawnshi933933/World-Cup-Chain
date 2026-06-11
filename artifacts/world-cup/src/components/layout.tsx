import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Trophy, Home, Search, List, Settings, Activity, Wallet } from "lucide-react";
import { useGetSettings, useGetBalance } from "@workspace/api-client-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: settings } = useGetSettings();
  const { data: balanceData } = useGetBalance({ query: { refetchInterval: 30000 } });

  const navItems = [
    { href: "/", label: "总览", icon: Home },
    { href: "/markets", label: "市场", icon: Search },
    { href: "/parlays", label: "我的串关", icon: List },
    { href: "/settings", label: "设置", icon: Settings },
  ];

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex flex-col dark pb-16 md:pb-0">
      {settings?.simulationMode && (
        <div className="bg-primary text-primary-foreground text-xs font-bold px-4 py-1 flex items-center justify-center gap-2">
          <Activity className="w-3 h-3" />
          模拟模式开启中
        </div>
      )}
      
      <header className="border-b border-border bg-card sticky top-0 z-50">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-primary hover:opacity-80 transition-opacity">
            <Trophy className="w-6 h-6" />
            <span className="font-bold text-lg hidden md:block">炜新联手征战世界杯</span>
          </Link>
          
          <nav className="hidden md:flex items-center gap-6">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2 text-sm font-medium transition-colors hover:text-primary",
                    isActive ? "text-primary" : "text-muted-foreground"
                  )}
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </Link>
              );
            })}
            {!settings?.simulationMode && (
              <div className="flex items-center gap-1.5 text-sm font-mono font-bold text-accent border border-accent/30 bg-accent/10 rounded-full px-3 py-1">
                <Wallet className="w-3.5 h-3.5" />
                {balanceData?.balanceUsdc != null
                  ? `$${balanceData.balanceUsdc.toFixed(2)}`
                  : "—"}
              </div>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8">
        {children}
      </main>

      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-card border-t border-border flex justify-around p-3 z-50 pb-safe">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center gap-1 text-[10px] font-medium transition-colors hover:text-primary",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              <Icon className="w-5 h-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}