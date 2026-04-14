import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Camera, Search, TrendingUp, Layers } from "lucide-react";

interface DbStats {
  cards: number;
  variations: number;
  cardsDelta: number | null;
  variationsDelta: number | null;
  lastImportedAt: string | null;
  lastCardsImportedAt: string | null;
  lastVariationsImportedAt: string | null;
}

function formatNumber(n: number) {
  return n.toLocaleString();
}

function formatDelta(delta: number | null) {
  if (delta === null) return null;
  if (delta > 0) return `+${formatNumber(delta)} added last update`;
  if (delta === 0) return "No change last update";
  return `${formatNumber(Math.abs(delta))} removed last update`;
}

export default function Home() {
  const [, navigate] = useLocation();

  const { data: stats, isLoading } = useQuery<DbStats>({
    queryKey: ["/api/card-database/stats"],
  });

  return (
    <div className="flex flex-col min-h-full">
      {/* Hero section */}
      <div className="bg-gradient-to-b from-blue-600 to-blue-700 text-white px-6 pt-10 pb-12">
        <h2 className="text-2xl font-bold mb-1">Sports Card Lookup</h2>
        <p className="text-blue-100 text-sm">
          Instantly identify cards and check real-time eBay prices.
        </p>
      </div>

      {/* Stats cards */}
      <div className="px-4 -mt-6 grid grid-cols-2 gap-3 mb-6">
        <div className="bg-white rounded-xl shadow-md p-4 border border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 bg-blue-50 rounded-lg">
              <TrendingUp className="w-4 h-4 text-blue-600" />
            </div>
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Cards</span>
          </div>
          {isLoading ? (
            <div className="h-8 w-20 bg-gray-100 animate-pulse rounded" />
          ) : (
            <>
              <p className="text-2xl font-bold text-gray-900">
                {formatNumber(stats?.cards ?? 0)}
              </p>
              {formatDelta(stats?.cardsDelta ?? null) && (
                <p className="text-xs text-green-600 mt-0.5">
                  {formatDelta(stats?.cardsDelta ?? null)}
                </p>
              )}
            </>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-md p-4 border border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 bg-teal-50 rounded-lg">
              <Layers className="w-4 h-4 text-teal-600" />
            </div>
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Parallels</span>
          </div>
          {isLoading ? (
            <div className="h-8 w-20 bg-gray-100 animate-pulse rounded" />
          ) : (
            <>
              <p className="text-2xl font-bold text-gray-900">
                {formatNumber(stats?.variations ?? 0)}
              </p>
              {formatDelta(stats?.variationsDelta ?? null) && (
                <p className="text-xs text-green-600 mt-0.5">
                  {formatDelta(stats?.variationsDelta ?? null)}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Lookup options */}
      <div className="px-4 flex-1">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
          Choose a lookup method
        </p>

        <button
          onClick={() => navigate("/scan")}
          className="w-full mb-3 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-2xl p-5 flex items-center gap-4 shadow-sm transition-colors text-left"
        >
          <div className="p-3 bg-white/20 rounded-xl flex-shrink-0">
            <Camera className="w-7 h-7" />
          </div>
          <div>
            <p className="font-semibold text-lg leading-tight">Scan Cards</p>
            <p className="text-blue-100 text-sm mt-0.5">
              Upload a photo — we'll identify the card automatically
            </p>
          </div>
        </button>

        <button
          onClick={() => navigate("/search")}
          className="w-full bg-white hover:bg-gray-50 active:bg-gray-100 border border-gray-200 text-gray-800 rounded-2xl p-5 flex items-center gap-4 shadow-sm transition-colors text-left"
        >
          <div className="p-3 bg-blue-50 rounded-xl flex-shrink-0">
            <Search className="w-7 h-7 text-blue-600" />
          </div>
          <div>
            <p className="font-semibold text-lg leading-tight text-gray-900">Manual Lookup</p>
            <p className="text-gray-500 text-sm mt-0.5">
              Type in player, year, brand and card number
            </p>
          </div>
        </button>
      </div>
    </div>
  );
}
