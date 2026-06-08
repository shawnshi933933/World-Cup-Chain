import { useState } from "react";
import { useGetMarkets } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, RefreshCw, AlertCircle } from "lucide-react";
import { useLocation } from "wouter";

export default function Markets() {
  const [search, setSearch] = useState("");
  const { data: markets, isLoading, refetch } = useGetMarkets({ search });
  const [, setLocation] = useLocation();

  const handleCreateParlay = (marketId: string) => {
    setLocation(`/parlays/new?market=${marketId}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black font-serif tracking-tight">世界杯市场</h1>
          <p className="text-muted-foreground mt-1">从 Polymarket 获取最新的比赛赔率</p>
        </div>
        
        <div className="flex w-full md:w-auto gap-2">
          <div className="relative w-full md:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input 
              placeholder="搜索比赛..." 
              className="pl-9 bg-card/50"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button variant="outline" size="icon" onClick={() => refetch()} title="刷新">
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map(i => (
            <Card key={i} className="animate-pulse bg-muted h-48 border-0"></Card>
          ))}
        </div>
      ) : markets && markets.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {markets.map((market) => (
            <Card key={market.id} className="border-border/50 bg-card/50 hover:border-primary/50 transition-colors flex flex-col">
              <CardHeader className="pb-3 flex-1">
                <div className="flex justify-between items-start mb-2 gap-2">
                  <Badge variant={market.active ? "default" : "secondary"} className={market.active ? "bg-accent text-accent-foreground hover:bg-accent" : ""}>
                    {market.active ? "开放投注" : "已结束"}
                  </Badge>
                  {market.resolved && <Badge variant="outline">已结算</Badge>}
                </div>
                <CardTitle className="text-lg leading-tight">{market.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-2">
                  {market.outcomes.map((outcome, idx) => (
                    <div key={idx} className="bg-background rounded-lg p-2 flex flex-col items-center justify-center text-center border border-border/50">
                      <span className="text-xs text-muted-foreground truncate w-full px-1" title={outcome.name}>{outcome.name}</span>
                      <span className="font-bold text-primary mt-1">1赔{outcome.odds.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
                
                <Button 
                  className="w-full" 
                  disabled={!market.active}
                  onClick={() => handleCreateParlay(market.id)}
                >
                  添加到串关
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-20 bg-card/30 rounded-xl border border-dashed">
          <AlertCircle className="w-10 h-10 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-xl font-bold mb-2">未找到市场</h3>
          <p className="text-muted-foreground">没有找到符合搜索条件的比赛市场。</p>
        </div>
      )}
    </div>
  );
}