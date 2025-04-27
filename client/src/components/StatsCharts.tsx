import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { formatCurrency } from "@/lib/utils";
import { useState, useEffect } from "react";

interface SportDistribution {
  name: string;
  value: number;
  color: string;
}

interface YearValue {
  year: string;
  value: number;
}

interface StatsData {
  sportDistribution: SportDistribution[];
  valueByYear: YearValue[];
  mostValuableCards: any[];
}

const COLORS = ['#3b82f6', '#f97316', '#22c55e', '#8b5cf6', '#ec4899'];

export default function StatsCharts() {
  const [directSportData, setDirectSportData] = useState<SportDistribution[]>([]);
  const [directYearData, setDirectYearData] = useState<YearValue[]>([]);
  const [isDirectLoading, setIsDirectLoading] = useState(true);
  
  // Direct API call to calculate chart data
  useEffect(() => {
    async function fetchCardsForStats() {
      try {
        setIsDirectLoading(true);
        const response = await fetch('/api/cards');
        if (response.ok) {
          const cards = await response.json();
          
          // Calculate sport distribution
          const sportCounts = {};
          cards.forEach(card => {
            const sportName = card.sport?.name || 'Unknown';
            sportCounts[sportName] = (sportCounts[sportName] || 0) + 1;
          });
          
          const sportDistribution = Object.entries(sportCounts).map(([name, value], index) => ({
            name,
            value: value as number,
            color: COLORS[index % COLORS.length]
          }));
          
          // Calculate year distribution
          const yearValues = {};
          cards.forEach(card => {
            const year = card.year?.toString() || 'Unknown';
            const value = card.estimatedValue ? Number(card.estimatedValue) : 0;
            yearValues[year] = (yearValues[year] || 0) + value;
          });
          
          const valueByYear = Object.entries(yearValues).map(([year, value]) => ({
            year,
            value: value as number
          }));
          
          console.log("Stats charts - direct data:", {
            sportDistribution,
            valueByYear
          });
          
          setDirectSportData(sportDistribution);
          setDirectYearData(valueByYear);
        }
      } catch (error) {
        console.error("Error fetching cards for stats charts:", error);
      } finally {
        setIsDirectLoading(false);
      }
    }
    
    fetchCardsForStats();
  }, []);
  
  // Reference only - no longer using this data
  const { isLoading, error } = useQuery<StatsData>({
    queryKey: ['/api/stats/charts'],
    enabled: false // Disable the query since we're using direct data
  });

  // Use loading state while direct data is being fetched
  if (isDirectLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 mb-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-slate-500">Cards by Sport</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-60 flex items-center justify-center bg-slate-50 rounded animate-pulse"></div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-slate-500">Value by Year</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-60 flex items-center justify-center bg-slate-50 rounded animate-pulse"></div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // If we have no direct data, show empty state
  if (directSportData.length === 0 && directYearData.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-4 mb-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-slate-500">Cards by Sport</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-60 flex items-center justify-center bg-slate-50 rounded">
              <p className="text-slate-400">Add cards to see statistics</p>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-slate-500">Value by Year</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-60 flex items-center justify-center bg-slate-50 rounded">
              <p className="text-slate-400">Add cards to see statistics</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Use direct data from the cards
  return (
    <div className="grid grid-cols-1 gap-4 mb-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-slate-500">Cards by Sport</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={directSportData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  outerRadius={75}
                  fill="#8884d8"
                  dataKey="value"
                  label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                >
                  {directSportData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => [`${value} cards`, 'Count']} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
      
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-slate-500">Value by Year</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={directYearData}
                margin={{
                  top: 5,
                  right: 30,
                  left: 30,
                  bottom: 5,
                }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="year" />
                <YAxis 
                  width={50}
                  tickFormatter={(value) => {
                    if (typeof value === 'number') {
                      return formatCurrency(value).replace('$', '');
                    }
                    return value;
                  }} 
                />
                <Tooltip 
                  formatter={(value: any) => {
                    if (typeof value === 'number') {
                      return [formatCurrency(value), 'Value'];
                    }
                    return [value, 'Value'];
                  }}
                />
                <Bar dataKey="value" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
