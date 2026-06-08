import { useGetParlayStats, useGetParlays } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";
import { ArrowRight, PlusCircle, Trophy, Activity, Wallet, TrendingUp, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default function Home() {
  const { data: stats, isLoading: statsLoading } = useGetParlayStats();
  const { data: parlays, isLoading: parlaysLoading } = useGetParlays({ status: "active" });

  return (
    <div className="space-y-12">
      <section className="text-center py-12 md:py-20 relative overflow-hidden rounded-3xl border border-primary/20 bg-gradient-to-b from-card to-background">
        <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1518605368461-1e125222058c?q=80&w=2070&auto=format&fit=crop')] bg-cover bg-center opacity-10 mix-blend-luminosity"></div>
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/80 to-transparent"></div>
        <div className="relative z-10 px-4">
          <Badge variant="outline" className="mb-6 border-primary/50 text-primary">2026 WORLD CUP</Badge>
          <h1 className="text-4xl md:text-6xl lg:text-7xl font-black tracking-tight text-foreground mb-6 font-serif">
            炜新联手征战世界杯
          </h1>
          <p className="text-muted-foreground text-lg md:text-xl max-w-2xl mx-auto mb-10">
            专属的世界杯串关战情室。数据驱动，理性分析，激情投注。
          </p>
          <Button asChild size="lg" className="h-14 px-8 text-lg rounded-full shadow-lg shadow-primary/20 hover:scale-105 transition-transform">
            <Link href="/parlays/new">
              <PlusCircle className="mr-2 h-5 w-5" />
              新建串关
            </Link>
          </Button>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
          <Activity className="w-6 h-6 text-primary" />
          战绩总览
        </h2>
        
        {statsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 animate-pulse">
            {[1, 2, 3, 4].map(i => (
              <Card key={i} className="bg-muted h-32 border-0"></Card>
            ))}
          </div>
        ) : stats ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="border-border/50 bg-card/50 backdrop-blur">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">总计投注</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-black">${stats.totalStaked.toFixed(2)}</div>
              </CardContent>
            </Card>
            <Card className="border-border/50 bg-card/50 backdrop-blur">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">总计返还</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-black">${stats.totalPayout.toFixed(2)}</div>
              </CardContent>
            </Card>
            <Card className="border-border/50 bg-card/50 backdrop-blur">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">净利润</CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-3xl font-black ${stats.netProfit >= 0 ? "text-accent" : "text-destructive"}`}>
                  {stats.netProfit > 0 ? "+" : ""}${stats.netProfit.toFixed(2)}
                </div>
              </CardContent>
            </Card>
            <Card className="border-border/50 bg-card/50 backdrop-blur">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">串关胜率</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-black">
                  {stats.totalParlays > 0 ? Math.round((stats.wonParlays / stats.totalParlays) * 100) : 0}%
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {stats.wonParlays} 胜 / {stats.lostParlays} 负
                </div>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </section>

      <section>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Trophy className="w-6 h-6 text-primary" />
            进行中的串关
          </h2>
          <Button variant="ghost" asChild className="text-sm">
            <Link href="/parlays">查看全部 <ArrowRight className="ml-2 w-4 h-4" /></Link>
          </Button>
        </div>

        {parlaysLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-pulse">
            <Card className="bg-muted h-48 border-0"></Card>
            <Card className="bg-muted h-48 border-0"></Card>
          </div>
        ) : parlays && parlays.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {parlays.map((parlay) => (
              <Card key={parlay.id} className="hover:border-primary/50 transition-colors group cursor-pointer border-border/50 bg-card/50">
                <Link href={`/parlays/${parlay.id}`}>
                  <CardHeader className="pb-2 flex flex-row items-start justify-between">
                    <div>
                      <CardTitle className="text-lg group-hover:text-primary transition-colors">{parlay.name}</CardTitle>
                      <div className="text-sm text-muted-foreground mt-1">进度: {parlay.currentLegIndex}/{parlay.totalLegs}</div>
                    </div>
                    <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">进行中</Badge>
                  </CardHeader>
                  <CardContent>
                    <div className="flex justify-between items-end mt-4">
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">当前金额</div>
                        <div className="text-2xl font-bold">${parlay.currentAmount.toFixed(2)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground mb-1">潜在收益</div>
                        <div className="text-xl font-bold text-accent">${parlay.potentialPayout.toFixed(2)}</div>
                      </div>
                    </div>
                  </CardContent>
                </Link>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="border-dashed border-2 bg-transparent">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
                <List className="w-8 h-8 text-muted-foreground" />
              </div>
              <p className="text-lg font-medium text-foreground">没有进行中的串关</p>
              <p className="text-muted-foreground mb-6">所有的串关都已经结算，或者还没有开始。</p>
              <Button asChild>
                <Link href="/parlays/new">创建新串关</Link>
              </Button>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}