import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

interface StatsSummaryProps {
  totalValue: number;
  changeValue: number;
  changePercent: number;
}

export default function StatsSummary() {
  const { data, isLoading, error } = useQuery<{
    totalValue: number;
    changeValue: number;
    changePercent: number;
  }>({
    queryKey: ['/api/stats/summary'],
  });

  if (isLoading) {
    return (
      <Card className="bg-white rounded-lg p-4 shadow-sm mb-4">
        <div className="animate-pulse">
          <div className="h-4 bg-slate-200 rounded w-1/3 mb-2"></div>
          <div className="h-8 bg-slate-200 rounded w-1/2 mb-2"></div>
        </div>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card className="bg-white rounded-lg p-4 shadow-sm mb-4">
        <h3 className="text-sm font-medium text-slate-500 mb-2">Total Collection Value</h3>
        <div className="flex items-baseline">
          <span className="text-2xl font-bold">{formatCurrency(0)}</span>
        </div>
      </Card>
    );
  }

  const { totalValue, changeValue, changePercent } = data;

  return (
    <Card className="bg-white rounded-lg p-4 shadow-sm mb-4">
      <h3 className="text-sm font-medium text-slate-500 mb-2">Total Collection Value</h3>
      <div className="flex items-baseline">
        <span className="text-2xl font-bold">${totalValue.toLocaleString()}</span>
        {changeValue !== 0 && (
          <span className={`ml-2 text-xs font-medium ${changeValue > 0 ? 'text-green-600' : 'text-red-600'}`}>
            {changeValue > 0 ? '↑' : '↓'} ${Math.abs(changeValue)} ({changePercent.toFixed(1)}%)
          </span>
        )}
      </div>
    </Card>
  );
}
