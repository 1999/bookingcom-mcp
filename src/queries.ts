export const REVIEW_LIST_QUERY = `
query ReviewList($input: ReviewListFrontendInput!) {
  reviewListFrontend(input: $input) {
    ... on ReviewListFrontendResult {
      ratingScores {
        name
        translation
        value
        __typename
      }
      reviewScoreFilter {
        name
        value
        count
        __typename
      }
      languageFilter {
        name
        value
        count
        __typename
      }
      customerTypeFilter {
        count
        name
        value
        __typename
      }
      reviewCard {
        reviewUrl
        guestDetails {
          username
          countryCode
          countryName
          guestTypeTranslation
          anonymous
          __typename
        }
        bookingDetails {
          customerType
          roomType {
            id
            name
            __typename
          }
          checkoutDate
          checkinDate
          numNights
          __typename
        }
        reviewedDate
        isTranslatable
        helpfulVotesCount
        reviewScore
        textDetails {
          title
          positiveText
          negativeText
          lang
          __typename
        }
        isApproved
        partnerReply {
          reply
          __typename
        }
        photos {
          id
          urls {
            size
            url
            __typename
          }
          __typename
        }
        __typename
      }
      reviewsCount
      sorters {
        name
        value
        __typename
      }
      __typename
    }
    ... on ReviewsFrontendError {
      statusCode
      message
      __typename
    }
    __typename
  }
}
`.trim();

// ── Per-review types ──────────────────────────────────────────────────────────

export interface RoomType {
  id: number;
  name: string;
  __typename: string;
}

export interface GuestDetails {
  username: string;
  countryCode: string;
  countryName: string;
  guestTypeTranslation: string;
  anonymous: boolean;
  __typename: string;
}

export interface BookingDetails {
  customerType: string;
  roomType: RoomType | null;
  checkoutDate: string;
  checkinDate: string;
  numNights: number;
  __typename: string;
}

export interface TextDetails {
  title: string;
  positiveText: string;
  negativeText: string;
  lang: string;
  __typename: string;
}

export interface PartnerReply {
  reply: string;
  __typename: string;
}

export interface ReviewCard {
  reviewUrl: string;
  guestDetails: GuestDetails;
  bookingDetails: BookingDetails;
  reviewedDate: number; // unix timestamp
  isTranslatable: boolean;
  helpfulVotesCount: number;
  reviewScore: number;
  textDetails: TextDetails;
  isApproved: boolean;
  partnerReply: PartnerReply | null;
  __typename: string;
}

// ── Aggregate / metadata types ────────────────────────────────────────────────

export interface RatingScore {
  name: string;        // e.g. "cleanliness"
  translation: string; // e.g. "Cleanliness"
  value: number;       // 0–10
  __typename: string;
}

export interface FilterItem {
  name: string;   // display label
  value: string;  // machine value / score threshold
  count: number;
  __typename: string;
}

// ── Result types ──────────────────────────────────────────────────────────────

/** Basic list result (used by get_hotel_reviews) */
export interface ReviewListResult {
  reviewsCount: number;
  reviewCard: ReviewCard[];
}

/** Full result including hotel-wide aggregates (used by summarize_hotel) */
export interface ReviewListFullResult extends ReviewListResult {
  ratingScores: RatingScore[];
  reviewScoreFilter: FilterItem[];
  customerTypeFilter: FilterItem[];
  languageFilter: FilterItem[];
}

// ── Input type ────────────────────────────────────────────────────────────────

export interface ReviewListFrontendInput {
  hotelId: number;
  ufi: number;
  hotelCountryCode: string;
  sorter: string;
  filters: {
    text?: string;
    language?: string;
    reviewScore?: number;
    customerType?: string;
  };
  skip: number;
  limit: number;
  hotelScore: number;
  upsortReviewUrl: string;
  searchFeatures: {
    destId: number;
    destType: string;
  };
}
