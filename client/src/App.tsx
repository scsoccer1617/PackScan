import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import PriceLookup from "@/pages/PriceLookup";
import CardSearch from "@/pages/CardSearch";
import CardDatabaseAdmin from "@/pages/CardDatabaseAdmin";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="max-w-lg mx-auto min-h-screen flex flex-col bg-white relative">
        <Header />

        <main className="flex-1 overflow-y-auto pb-4">
          <Switch>
            <Route path="/" component={() => <Home />} />
            <Route path="/scan" component={() => <PriceLookup />} />
            <Route path="/search" component={() => <CardSearch />} />
            <Route path="/admin/card-database" component={() => <CardDatabaseAdmin />} />
            <Route component={NotFound} />
          </Switch>
        </main>

        <Footer />
      </div>
    </QueryClientProvider>
  );
}

export default App;
