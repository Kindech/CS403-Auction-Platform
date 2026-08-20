export interface User {
  id: string;
  email: string;
  display_name: string;
}

export type ItemStatus = "upcoming" | "live" | "ended";

export interface Item {
  id: string;
  seller_id: string;
  seller_name?: string;
  title: string;
  description: string;
  image_url: string;
  starting_price: number;
  bid_increment: number;
  current_price: number;
  current_bidder?: string;
  start_time: string;
  end_time: string;
  status: ItemStatus;
  winner_id?: string;
  winner_name?: string;
  final_price?: number;
  created_at: string;
}

export type BidStatus = "accepted" | "rejected";

export interface Bid {
  id: string;
  item_id: string;
  item_title?: string;
  user_id: string;
  user_name?: string;
  amount: number;
  status: BidStatus;
  reason?: string;
  created_at: string;
}

export interface WSEvent {
  type: "sync" | "price_update" | "bid_rejected" | "auction_ended" | "outbid";
  item_id: string;
  price?: number;
  bidder_name?: string;
  end_time_ms?: number;
  min_increment?: number;
  soft_extended?: boolean;
  reason?: string;
  winner_name?: string;
  final_price?: number;
}
