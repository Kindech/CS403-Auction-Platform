import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { Layout } from "./components/Layout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Dashboard } from "./pages/Dashboard";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { AuctionRoom } from "./pages/AuctionRoom";
import { SellerTools } from "./pages/SellerTools";
import { MyBids } from "./pages/MyBids";

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <AuthProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="login" element={<Login />} />
              <Route path="register" element={<Register />} />
              <Route path="auctions/:id" element={<AuctionRoom />} />
              <Route
                path="seller"
                element={
                  <ProtectedRoute>
                    <SellerTools />
                  </ProtectedRoute>
                }
              />
              <Route
                path="me/bids"
                element={
                  <ProtectedRoute>
                    <MyBids />
                  </ProtectedRoute>
                }
              />
            </Route>
          </Routes>
        </AuthProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
