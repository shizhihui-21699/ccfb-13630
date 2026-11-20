export const SCHEMA_SDL = /* GraphQL */ `
  interface Node {
    id: ID!
    createdAt: String!
  }

  type User implements Node {
    id: ID!
    createdAt: String!
    email: String!
    displayName: String!
    role: Role!
    posts(first: Int, last: Int): [Post!]!
    friends(first: Int, last: Int): [User!]!
    orders(limit: Int): [Order!]!
  }

  type Post implements Node {
    id: ID!
    createdAt: String!
    title: String!
    body: String!
    author: User!
    tags: [String!]!
    comments(first: Int, last: Int): [Comment!]!
    viewerCanEdit: Boolean!
  }

  type Comment implements Node {
    id: ID!
    createdAt: String!
    body: String!
    author: User!
    post: Post!
  }

  type Product implements Node {
    id: ID!
    createdAt: String!
    name: String!
    priceCents: Int!
    sku: String!
    reviews(first: Int, last: Int): [Review!]!
  }

  type Review implements Node {
    id: ID!
    createdAt: String!
    rating: Int!
    body: String!
    product: Product!
  }

  type Order implements Node {
    id: ID!
    createdAt: String!
    totalCents: Int!
    status: OrderStatus!
    items(limit: Int): [OrderItem!]!
  }

  type OrderItem {
    product: Product!
    quantity: Int!
    unitPriceCents: Int!
  }

  enum Role {
    ADMIN
    MEMBER
    GUEST
  }

  enum OrderStatus {
    PENDING
    PAID
    SHIPPED
    CANCELLED
  }

  union SearchResult = User | Post | Product

  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type PostConnection {
    edges: [PostEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type PostEdge {
    cursor: String!
    node: Post!
  }

  type AnalyticsBucket {
    date: String!
    signups: Int!
    activeUsers: Int!
    revenueCents: Int!
  }

  type Query {
    me: User
    user(id: ID!): User
    users(first: Int, last: Int): [User!]!
    posts(first: Int, last: Int, after: String): PostConnection!
    post(id: ID!): Post
    products(first: Int, last: Int, take: Int): [Product!]!
    product(sku: ID!): Product
    search(term: String!, first: Int, last: Int): [SearchResult!]!
    analytics(days: Int!): [AnalyticsBucket!]!
    auditLog(limit: Int): [String!]!
    node(id: ID!): Node
  }

  type Mutation {
    createPost(title: String!, body: String!): Post!
    updateProfile(displayName: String!): User!
  }
`;
